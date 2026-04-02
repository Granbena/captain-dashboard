export default async function handler(req, res) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const providedSecret = req.headers["x-cron-secret"];

    if (!cronSecret || providedSecret !== cronSecret) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    const supabaseAutofillUrl = process.env.SUPABASE_AUTOFILL_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseAutofillUrl || !supabaseServiceRoleKey) {
      return res.status(500).json({
        ok: false,
        error: "Missing environment variables"
      });
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

    return res.status(response.ok ? 200 : 500).json({
      ok: response.ok,
      source: "vercel-cron",
      data
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
}
