// Edge functions import supabase-js by URL (Deno). Map that URL to the npm
// package's types so Node tests can typecheck shared modules such as
// supabase/functions/_shared/retrieval.ts.
declare module "https://esm.sh/@supabase/supabase-js@2.57.2" {
  export * from "@supabase/supabase-js";
}
