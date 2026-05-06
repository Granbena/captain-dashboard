export default async function handler(req, res) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const activeAlertsSecret = process.env.ACTIVE_ALERTS_SECRET;

    if (cronSecret) {
      const authHeader = req.headers.authorization || "";
      const expectedHeader = `Bearer ${cronSecret}`;

      if (authHeader !== expectedHeader) {
        return res.status(401).json({
          ok: false,
          error: "Unauthorized",
        });
      }
    }

    if (!activeAlertsSecret) {
      return res.status(500).json({
        ok: false,
        error: "Missing ACTIVE_ALERTS_SECRET in Vercel environment variables",
      });
    }

    const url = new URL(
      "https://dglgdgdujvjglnpeazhw.supabase.co/functions/v1/captain-active-alerts"
    );

    url.searchParams.set("secret", activeAlertsSecret);
    url.searchParams.set("_ts", Date.now().toString());

    const response = await fetch(url.toString(), {
      method: "GET",
      cache: "no-store",
    });

    const data = await response.json().catch(() => null);

    return res.status(response.status).json({
      ok: response.ok,
      source: "vercel-cron",
      target: "captain-active-alerts",
      responseStatus: response.status,
      responseBody: data,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      source: "vercel-cron",
      target: "captain-active-alerts",
      error: error.message || String(error),
    });
  }
}
