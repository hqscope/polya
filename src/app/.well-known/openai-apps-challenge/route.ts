// OpenAI plugin-directory domain verification. The token comes from the
// OpenAI Platform submission page; set it as OPENAI_APPS_CHALLENGE in Vercel.
export const dynamic = "force-dynamic";

export function GET(): Response {
  const token = process.env.OPENAI_APPS_CHALLENGE?.trim();
  if (!token) return new Response("Not found", { status: 404 });
  return new Response(token, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
