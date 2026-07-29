// Authors the committed synthetic demo course under fixtures/demo-course/.
// Deterministic, copyright-safe, and exercises every feature: a lecture PDF,
// a numbered-method deck (for procedure extraction), a Canvas-style HTML page,
// a timed .vtt transcript, and a golden-set for the eval harness.
//
// Run once (and whenever the fixture changes): `node scripts/make-fixtures.ts`.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "fixtures", "demo-course");

async function textPdf(pages: string[][]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = pdf.addPage([612, 792]);
    let y = 740;
    for (const line of lines) {
      page.drawText(line, { x: 54, y, size: 13, font });
      y -= 22;
    }
  }
  return await pdf.save();
}

async function main() {
  await mkdir(join(root, "pdfs"), { recursive: true });
  await mkdir(join(root, "pages"), { recursive: true });
  await mkdir(join(root, "transcripts"), { recursive: true });

  // 1. A plain lecture reading PDF (factual content for citation tests).
  const lecture = await textPdf([
    [
      "Bio 1A - Lecture 7: Cellular Respiration",
      "",
      "Cellular respiration is how cells convert glucose into usable energy.",
      "It has three stages: glycolysis, the citric acid cycle, and the",
      "electron transport chain.",
      "",
      "Glycolysis takes place in the cytosol and splits glucose into two",
      "molecules of pyruvate, producing a small amount of ATP and NADH.",
    ],
    [
      "The electron transport chain sits in the inner mitochondrial membrane.",
      "",
      "Oxygen is the terminal electron acceptor of the electron transport",
      "chain. Without oxygen to accept electrons at the end of the chain,",
      "the whole chain backs up and ATP production by oxidative",
      "phosphorylation stops. This is why aerobic organisms must breathe.",
      "",
      "The proton gradient built across the membrane drives ATP synthase.",
    ],
  ]);
  await writeFile(join(root, "pdfs", "lecture-7-respiration.pdf"), lecture);

  // 2. A numbered-method slide deck (procedure extraction target).
  const method = await textPdf([
    [
      "Method: Choosing a Statistical Test",
      "",
      "1. Identify the type of outcome variable.",
      "2. Determine the number of groups being compared.",
      "3. Check whether the observations are paired.",
      "4. Verify the distributional assumptions of the candidate test.",
      "5. Select the test that matches all of the answers above.",
    ],
  ]);
  await writeFile(join(root, "pdfs", "choosing-a-test-method.pdf"), method);

  // 3. A Canvas-style HTML page.
  const pageHtml = `<h2>Week 6 Overview</h2>
<p>This week focuses on how cells make energy. Before the Thursday quiz,
watch the Lecture 7 recording and review the cellular respiration reading.</p>
<ul>
  <li>The quiz covers glycolysis and the electron transport chain.</li>
  <li>Office hours are Wednesday at 3pm in the Life Sciences building.</li>
</ul>`;
  await writeFile(join(root, "pages", "week-6-overview.html"), pageHtml, "utf8");

  // 4. A timed transcript (.vtt) with a citable moment.
  const vtt = `WEBVTT

00:00:00.000 --> 00:00:24.000
Welcome to lecture seven. Today we work through cellular respiration and where the energy actually comes from.

00:00:24.000 --> 00:00:52.000
The key idea for the exam is that oxygen is the terminal electron acceptor. Remember that phrase.

00:00:52.000 --> 00:01:20.000
If oxygen is not present, the electron transport chain cannot hand off its electrons, and ATP production stalls.

00:13:30.000 --> 00:14:05.000
Later in the course we will connect this to how exercise physiology depends on oxygen delivery.
`;
  await writeFile(join(root, "transcripts", "lecture-7.vtt"), vtt, "utf8");

  // 5. Manifest the seeder reads, + the eval golden set.
  const manifest = {
    course_name: "Bio 1A (demo)",
    files: [
      {
        title: "Lecture 7 - Cellular Respiration",
        origin: "canvas_file",
        source_kind: "pdf",
        content_role: "material",
        path: "pdfs/lecture-7-respiration.pdf",
        content_type: "application/pdf",
        ext: "pdf",
      },
      {
        title: "Choosing a Statistical Test (method)",
        origin: "canvas_file",
        source_kind: "pdf",
        content_role: "material",
        path: "pdfs/choosing-a-test-method.pdf",
        content_type: "application/pdf",
        ext: "pdf",
      },
      {
        title: "Week 6 Overview",
        origin: "canvas_page",
        source_kind: "html",
        content_role: "material",
        path: "pages/week-6-overview.html",
        content_type: "text/html",
        ext: "html",
      },
      {
        title: "Lecture 7 recording transcript",
        origin: "upload_transcript",
        source_kind: "transcript_vtt",
        content_role: "material",
        path: "transcripts/lecture-7.vtt",
        content_type: "text/vtt",
        ext: "vtt",
      },
    ],
  };
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const golden = [
    {
      question: "Why does the electron transport chain need oxygen?",
      expect_source: "Lecture 7 - Cellular Respiration",
      expect_terms: ["terminal electron acceptor", "oxygen"],
    },
    {
      question: "What are the steps for choosing a statistical test?",
      expect_source: "Choosing a Statistical Test (method)",
      expect_terms: ["number of groups", "paired"],
    },
    {
      question: "When are office hours this week?",
      expect_source: "Week 6 Overview",
      expect_terms: ["Wednesday", "3pm"],
    },
    {
      question: "What did the professor say was key for the exam about oxygen?",
      expect_source: "Lecture 7 recording transcript",
      expect_terms: ["terminal electron acceptor"],
    },
  ];
  await writeFile(
    join(here, "eval", "golden-set.json"),
    JSON.stringify(golden, null, 2),
    "utf8",
  );

  console.log(`Fixtures written to ${root}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
