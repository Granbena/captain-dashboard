export default async function handler(req, res) {
  try {
    const supabaseAutofillUrl = process.env.SUPABASE_AUTOFILL_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const cronSecret = process.env.CRON_SECRET;

    if (!supabaseAutofillUrl || !supabaseServiceRoleKey || !cronSecret) {
      return res.status(500).json({
        ok: false,
        error: "Missing environment variables",
        hasUrl: !!supabaseAutofillUrl,
        hasServiceRole: !!supabaseServiceRoleKey,
        hasCronSecret: !!cronSecret
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

    const rawText = await response.text();

    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch (parseError) {
      return res.status(500).json({
        ok: false,
        error: "Supabase response is not valid JSON",
        status: response.status,
        rawText
      });
    }

    return res.status(response.ok ? 200 : 500).json({
      ok: response.ok,
      source: "vercel-cron",
      status: response.status,
      data
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
}
