// Insert helpers for procedures and transcript segments as embedded
// content_units, plus their sidecar rows (polya_procedures / _steps).
import { embedTexts, toVectorLiteral } from "./embeddings.ts";
import { service } from "./service.ts";
import { chargeEmbeddingBudget } from "./import-caps.ts";
import type { SourceRow } from "./ingest.ts";
import {
  procedureText,
  stepText,
  type ExtractedProcedure,
} from "./procedures.ts";
import type { TranscriptSegment } from "./transcripts.ts";

// For each extracted procedure: create the procedure + step sidecar rows, then
// embed a whole-procedure unit and one unit per step. Returns content_units count.
export async function embedAndInsertProcedures(
  source: SourceRow,
  procedures: ExtractedProcedure[],
  ordinalStart: number,
): Promise<number> {
  if (procedures.length === 0) return 0;

  // Charged before the sidecar inserts, so a busy budget can't leave
  // procedure rows behind for the retry to duplicate.
  await chargeEmbeddingBudget(
    service,
    source.user_id,
    procedures.flatMap((procedure) => [
      procedureText(procedure),
      ...procedure.steps.map((step) => stepText(procedure, step)),
    ]),
  );

  let ordinal = ordinalStart;
  const unitRows: Array<Record<string, unknown>> = [];
  const embedInputs: string[] = [];
  const embedTargets: Array<{ rowIndex: number }> = [];

  for (const procedure of procedures) {
    const { data: procRow, error: procErr } = await service
      .from("polya_procedures")
      .insert({
        user_id: source.user_id,
        course_id: source.course_id,
        source_id: source.id,
        title: procedure.title,
        page_start: procedure.pageStart,
        page_end: procedure.pageEnd,
        step_count: procedure.steps.length,
      })
      .select("id")
      .single();
    if (procErr || !procRow) throw new Error(`procedure insert failed: ${procErr?.message}`);
    const procedureId = procRow.id as string;

    const stepRows = procedure.steps.map((step) => ({
      user_id: source.user_id,
      procedure_id: procedureId,
      step_number: step.stepNumber,
      step_text: step.text,
      page: step.page,
    }));
    const { error: stepErr } = await service.from("polya_procedure_steps").insert(stepRows);
    if (stepErr) throw new Error(`procedure_steps insert failed: ${stepErr.message}`);

    // whole-procedure content unit
    embedInputs.push(procedureText(procedure));
    embedTargets.push({ rowIndex: unitRows.length });
    unitRows.push({
      user_id: source.user_id,
      course_id: source.course_id,
      source_id: source.id,
      ordinal: ordinal++,
      unit_type: "procedure",
      content_role: source.content_role,
      heading_path: `${source.title} › ${procedure.title}`,
      page_start: procedure.pageStart,
      page_end: procedure.pageEnd,
      procedure_id: procedureId,
      content: procedureText(procedure),
    });

    // per-step content units
    for (const step of procedure.steps) {
      embedInputs.push(stepText(procedure, step));
      embedTargets.push({ rowIndex: unitRows.length });
      unitRows.push({
        user_id: source.user_id,
        course_id: source.course_id,
        source_id: source.id,
        ordinal: ordinal++,
        unit_type: "procedure_step",
        content_role: source.content_role,
        heading_path: `${source.title} › ${procedure.title}`,
        page_start: step.page,
        page_end: step.page,
        procedure_id: procedureId,
        step_number: step.stepNumber,
        content: stepText(procedure, step),
      });
    }
  }

  const embedded = await embedTexts(embedInputs, "RETRIEVAL_DOCUMENT");
  embedded.forEach((embedding, i) => {
    const row = unitRows[embedTargets[i]!.rowIndex]!;
    row.embedding = toVectorLiteral(embedding.values);
    row.embedding_model = embedding.model;
  });

  const { error } = await service
    .from("polya_content_units")
    .upsert(unitRows, { onConflict: "source_id,ordinal", ignoreDuplicates: true });
  if (error) throw new Error(`procedure content_units insert failed: ${error.message}`);
  return unitRows.length;
}

export async function embedAndInsertTranscript(
  source: SourceRow,
  segments: TranscriptSegment[],
): Promise<number> {
  if (segments.length === 0) return 0;

  const texts = segments.map((segment) => segment.text);
  await chargeEmbeddingBudget(service, source.user_id, texts);
  const embedded = await embedTexts(texts, "RETRIEVAL_DOCUMENT");

  const rows = segments.map((segment, i) => ({
    user_id: source.user_id,
    course_id: source.course_id,
    source_id: source.id,
    ordinal: segment.ordinal,
    unit_type: "transcript_segment",
    content_role: source.content_role,
    heading_path: source.title,
    t_start_ms: segment.tStartMs,
    t_end_ms: segment.tEndMs,
    content: segment.text,
    embedding: toVectorLiteral(embedded[i]!.values),
    embedding_model: embedded[i]!.model,
  }));

  const { error } = await service
    .from("polya_content_units")
    .upsert(rows, { onConflict: "source_id,ordinal", ignoreDuplicates: true });
  if (error) throw new Error(`transcript content_units insert failed: ${error.message}`);
  return rows.length;
}
