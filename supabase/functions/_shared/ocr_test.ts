// Pictures in PDFs: which slide-like pages count as having one, and that only
// those are metered and sent for a description. Builds real PDFs with pdf-lib
// and answers the model calls with a fake fetch.
//
// Run: deno test --allow-env --allow-read --no-check supabase/functions/_shared/ocr_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { PDFDocument, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";

// ocr.ts reads the key when it loads, so set it before importing.
Deno.env.set("ANTHROPIC_API_KEY", "test-key");
const { pagesWithPictures, readPdfPages } = await import("./ocr.ts");

// Page 1: text only. Page 2: text and a 500x400 diagram. Page 3: text and a
// 60x60 logo. Page 4: text and a 400x400 image inside a form. Page 5: blank.
async function deck(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const image = (width: number, height: number) =>
    doc.context.register(
      doc.context.stream(new Uint8Array(width * height * 3), {
        Type: "XObject",
        Subtype: "Image",
        Width: width,
        Height: height,
        ColorSpace: "DeviceRGB",
        BitsPerComponent: 8,
      }),
    );
  const page = (title: string) => {
    const p = doc.addPage();
    if (title) p.drawText(title, { x: 50, y: 700, size: 12, font });
    return p;
  };
  page("Glycolysis overview");
  page("Key enzymes").node.newXObject("Im1", image(500, 400));
  page("Summary").node.newXObject("Logo", image(60, 60));
  const form = doc.context.register(
    doc.context.stream("q Q", {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, 0, 10, 10],
      Resources: doc.context.obj({ XObject: { Im2: image(400, 400) } }),
    }),
  );
  page("Regulation").node.newXObject("Fm1", form);
  page("");
  return await doc.save();
}

Deno.test("a content-sized image counts as a picture; text, logos and nothing don't", async () => {
  const doc = await PDFDocument.load(await deck());
  assertEquals(pagesWithPictures(doc, [1, 2, 3, 4, 5]), [2, 4]);
});

Deno.test("a template image on most slides doesn't count, a real diagram next to it does", async () => {
  const doc = await PDFDocument.create();
  const image = (width: number, height: number) =>
    doc.context.register(
      doc.context.stream(new Uint8Array(width * height * 3), {
        Type: "XObject",
        Subtype: "Image",
        Width: width,
        Height: height,
        ColorSpace: "DeviceRGB",
        BitsPerComponent: 8,
      }),
    );
  const background = image(1280, 720);
  for (let i = 0; i < 6; i++) doc.addPage().node.newXObject("Bg", background);
  doc.getPage(3).node.newXObject("Diagram", image(600, 400));
  const loaded = await PDFDocument.load(await doc.save());
  assertEquals(pagesWithPictures(loaded, [1, 2, 3, 4, 5, 6]), [4]);
});

Deno.test("only slide-like pages with a picture are metered and described; image-only pages are transcribed", async () => {
  const prompts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: { type: string; text?: string }[] }[] };
    const prompt = body.messages[0]!.content.find((block) => block.type === "text")!.text!;
    prompts.push(prompt);
    const text = prompt.startsWith("The text on this PDF page")
      ? "Figure: the ten steps of glycolysis as a flowchart\nnot a figure line"
      : "Handwritten notes on the citric acid cycle\nFigure: a sketch of the cycle";
    return Promise.resolve(
      new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  try {
    const bytes = await deck();
    let charged = 0;
    const read = await readPdfPages(bytes.slice().buffer, [5], [1, 2, 3, 4], 5, async (count) => {
      charged += count;
    });
    assertEquals(charged, 3, "page 5 plus the two candidates that draw a picture");
    assertEquals(read.transcribed, [
      { pageNum: 5, text: "Handwritten notes on the citric acid cycle\nFigure: a sketch of the cycle" },
    ]);
    assertEquals(read.figures, [
      { pageNum: 2, text: "Figure: the ten steps of glycolysis as a flowchart" },
      { pageNum: 4, text: "Figure: the ten steps of glycolysis as a flowchart" },
    ]);
    assertEquals(prompts.length, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("nothing to send: no charge and no calls", async () => {
  let charged = 0;
  const read = await readPdfPages((await deck()).slice().buffer, [], [1, 3], 5, async (count) => {
    charged += count;
  });
  assertEquals(charged, 0);
  assertEquals(read, { transcribed: [], figures: [] });
});
