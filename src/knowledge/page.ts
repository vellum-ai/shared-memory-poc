import { validateConceptPath } from "../concept-path.js";
import {
  failureResponse,
  jsonResponse,
  KnowledgeError,
  openClone,
  readBlobAtHead,
  requireBase,
  searchParams,
} from "./base.js";

export async function handleKnowledgePage(request: Request, pluginDir: string): Promise<Response> {
  try {
    const params = searchParams(request);
    const base = requireBase(params);
    const requested = params.get("path");
    if (requested === null) {
      throw new KnowledgeError(400, "INVALID_PATH", "path is required.");
    }
    // validateConceptPath takes the path with its concepts/ prefix, and it is
    // what keeps traversal and non-page files out of the read below.
    const path = validateConceptPath(requested);
    const content = await readBlobAtHead(await openClone(pluginDir), path);
    return jsonResponse({ ok: true, base, path, content });
  } catch (error) {
    return failureResponse(error);
  }
}
