export async function GET(req) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const providedSecret = req.headers.get("x-cron-secret");

    if (!cronSecret || providedSecret !== cronSecret) {
      return new Response(
        JSON.stringify({ ok: false, error: "Unauthorized" }),
        { status: 401 }
      );
    }

    const supabaseAutofillUrl = process.env.SUPABASE_AUTOFILL_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseAutofillUrl || !supabaseServiceRoleKey) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing environment variables" }),
        { status: 500 }
      );
    }

    const url = new URL(supabaseAutofillUrl);
    url.searchParams.set("days", "60");
    url.searchParams.set("max_sync_days", "5");
    url.searchParams.set("_ts", Date.now().toString());

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
        apikey: supabaseServiceRoleKey,
        "x-cron-secret": cronSecret
      }
    });

    const data = await response.json();

    return new Response(
      JSON.stringify({
        ok: response.ok,
        source: "vercel-cron",
        data
      }),
      { status: response.ok ? 200 : 500 }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: String(error)
      }),
      { status: 500 }
    );
  }
}
