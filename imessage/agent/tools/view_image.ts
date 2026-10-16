// Shows the model a photo the sender attached. eve stages attachments in the sandbox, but HEIC
// (what iPhones send) isn't a format the model reads, so it arrives as a bare file name. This
// tool opens the staged file, converts HEIC to JPEG, and returns the pixels as a file part.
import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";

import {
  imagePathsInListing,
  imagePathsInMessages,
  LIST_ATTACHMENTS_COMMAND,
  pickImagePath,
  prepareImage,
  returnedFileName,
} from "../lib/images.ts";

type ViewImageOutput =
  | { status: "ok"; path: string; filename: string; mediaType: string; converted: boolean; base64: string }
  | { status: "error"; message: string };

export default defineTool({
  description:
    "Opens a photo or image the sender attached so you can see it, including iPhone HEIC photos that otherwise show up only as a file name. Call it before answering whenever a message has an attached image. Omit path to open the most recent image.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("The attachment path from the file label (/workspace/.eve/attachments/...) or its file name. Omit for the most recent image."),
  }),
  async execute({ path }, ctx): Promise<ViewImageOutput> {
    const sandbox = await ctx.getSandbox();
    let target = pickImagePath(path, imagePathsInMessages(ctx.messages));
    if (target === null) {
      const listing = await sandbox.run({ command: LIST_ATTACHMENTS_COMMAND });
      target = pickImagePath(path, imagePathsInListing(listing.stdout));
    }
    if (target === null) {
      return { status: "error", message: path ? `No attached image matches "${path}".` : "No attached image was found." };
    }
    const bytes = await sandbox.readBinaryFile({ path: target });
    if (bytes === null) return { status: "error", message: `The attachment ${target} couldn't be found.` };
    const image = await prepareImage(bytes);
    if (!image.ok) return { status: "error", message: image.message };
    return {
      status: "ok",
      path: target,
      filename: returnedFileName(target, image.converted),
      mediaType: image.mediaType,
      converted: image.converted,
      base64: Buffer.from(image.bytes).toString("base64"),
    };
  },
  toModelOutput(output) {
    if (output.status === "error") return toolOutput.text(output.message);
    const note = output.converted ? " (converted from HEIC to JPEG)" : "";
    return toolOutput.content([
      toolOutputPart.text(`Image ${output.path}${note}:`),
      toolOutputPart.file(output.base64, { mediaType: output.mediaType, filename: output.filename }),
    ]);
  },
});
