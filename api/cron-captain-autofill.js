export default async function handler(req, res) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization;
    const allowDebug = req.query.debug === "1";

    const isCronCall = authHeader === `Bearer ${cronSecret}`;

    if (!isCronCall && !allowDebug) {
      return res.status(401).json({
        ok: false,
        step: "auth",
        error: "Unauthorized"
      });
    }

    const supabaseAutofillUrl = process.env.SUPABASE_AUTOFILL_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseAutofillUrl || !supabaseServiceRoleKey) {
      return res.status(500).json({
        ok: false,
        step: "env-check",
        error: "Missing environment variables",
        hasSupabaseAutofillUrl: !!supabaseAutofillUrl,
        hasSupabaseServiceRoleKey: !!supabaseServiceRoleKey,
        hasCronSecret: !!cronSecret
      });
    }

    let url;
    try {
      url = new URL(supabaseAutofillUrl);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        step: "url-parse",
        error: "Invalid SUPABASE_AUTOFILL_URL",
        value: supabaseAutofillUrl,
        detail: String(e)
      });
    }

    url.searchParams.set("days", "60");
    url.searchParams.set("max_sync_days", "5");
    url.searchParams.set("_ts", Date.now().toString());

    let response;
    try {
      response = await fetch(url.toString(), {
  method: "GET",
  headers: {
    Authorization: `Bearer ${supabaseServiceRoleKey}`,
    apikey: supabaseServiceRoleKey,
    "x-cron-secret": cronSecret
  }
});
    } catch (e) {
      return res.status(500).json({
        ok: false,
        step: "fetch",
        error: "Fetch to Supabase failed",
        requestUrl: url.toString(),
        detail: String(e)
      });
    }

    const rawText = await response.text();

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = rawText;
    }

    return res.status(response.ok ? 200 : 500).json({
      ok: response.ok,
      step: "done",
      source: "vercel-cron",
      requestUrl: url.toString(),
      responseStatus: response.status,
      responseStatusText: response.statusText,
      responseBody: parsed
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      step: "top-level-catch",
      error: String(error),
      stack: error?.stack || null
    });
  }
}
