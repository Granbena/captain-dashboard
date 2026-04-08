export default async function handler(req, res) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
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
        apikey: supabaseServiceRoleKey
      }
    });

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
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
