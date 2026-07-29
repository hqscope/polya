const DEFAULT_SUPABASE_URL = "https://vcadcdgnwxjlgaoqktkd.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZjYWRjZGdud3hqbGdhb3FrdGtkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2MzU4NDQsImV4cCI6MjA4NzIxMTg0NH0.71j6kwkwwSeG9Jppu4IUyHORM033NFyXKemOd5kuDWk";

export interface SupabaseProjectConfig {
  url: string;
  anonKey: string;
}

export function getSupabaseConfig(): SupabaseProjectConfig {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || DEFAULT_SUPABASE_URL,
    anonKey:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
      DEFAULT_SUPABASE_ANON_KEY,
  };
}

export function getSupabaseFunctionsUrl(): string {
  const { url } = getSupabaseConfig();
  return `${url.replace(/\/$/, "")}/functions/v1`;
}
