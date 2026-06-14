import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

type AppRole = "store_user" | "supervisor" | "admin";

type UserAccess = {
  userId: string;
  role: AppRole;
  active: boolean;
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

async function getUserAccess(
  req: Request,
  supabaseUrl: string,
  anonKey: string,
  serviceRoleKey: string
): Promise<UserAccess> {
  const authHeader =
    req.headers.get("authorization") || req.headers.get("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Missing bearer token");
  }

  const token = authHeader.replace("Bearer ", "").trim();

  const authClient = createClient(supabaseUrl, anonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const { data: userData, error: userError } = await authClient.auth.getUser();

  if (userError || !userData.user) {
    throw new Error("Invalid or expired session");
  }

  const userId = userData.user.id;

  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, role, active")
    .eq("id", userId)
    .maybeSingle();

  if (profileError) {
    throw new Error(`Error reading profile: ${profileError.message}`);
  }

  if (!profile) {
    throw new Error("Profile not found");
  }

  if (!profile.active) {
    throw new Error("Inactive user");
  }

  const role = profile.role as AppRole;

  if (role !== "admin") {
    throw new Error("Access denied: admin role required");
  }

  return {
    userId,
    role,
    active: true,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);

    const businessDate = url.searchParams.get("business_date");
    const cutoffTime = url.searchParams.get("cutoff_time");
    const storeFilter = (url.searchParams.get("store_filter") || "").trim().toLowerCase();

    if (!businessDate || !cutoffTime) {
      return json(
        {
          ok: false,
          error: "Faltan parámetros requeridos: business_date y cutoff_time",
        },
        400
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    await getUserAccess(
      req,
      supabaseUrl,
      anonKey,
      serviceRoleKey
    );

    let query = supabase
      .from("captain_kpi_history_15m")
      .select(`
        business_date,
        store_uuid,
        store_name,
        orders_total,
        delivered_orders,
        active_orders,
        cancelled_orders,
        pick_sum_minutes,
        pick_count,
        delivery_sum_minutes,
        delivery_count,
        e2e_sum_minutes,
        e2e_count,
        promise_sum_minutes,
        promise_count,
        on_time_orders,
        on_time_eligible_orders
      `)
      .eq("business_date", businessDate)
      .lte("bucket_start", cutoffTime);

    if (storeFilter) {
      query = query.ilike("store_name", `%${storeFilter}%`);
    }

    const { data, error } = await query;

    if (error) {
      return json({ ok: false, error: error.message }, 500);
    }

    const rows = data ?? [];
    const grouped = new Map<string, any>();

    for (const row of rows) {
      const key = row.store_uuid || row.store_name;

      if (!grouped.has(key)) {
        grouped.set(key, {
          business_date: row.business_date,
          store_uuid: row.store_uuid,
          store_name: row.store_name,
          orders_total: 0,
          delivered_orders: 0,
          active_orders: 0,
          cancelled_orders: 0,
          pick_sum_minutes: 0,
          pick_count: 0,
          delivery_sum_minutes: 0,
          delivery_count: 0,
          e2e_sum_minutes: 0,
          e2e_count: 0,
          promise_sum_minutes: 0,
          promise_count: 0,
          on_time_orders: 0,
          on_time_eligible_orders: 0,
        });
      }

      const acc = grouped.get(key);
      acc.orders_total += Number(row.orders_total || 0);
      acc.delivered_orders += Number(row.delivered_orders || 0);
      acc.active_orders += Number(row.active_orders || 0);
      acc.cancelled_orders += Number(row.cancelled_orders || 0);

      acc.pick_sum_minutes += Number(row.pick_sum_minutes || 0);
      acc.pick_count += Number(row.pick_count || 0);

      acc.delivery_sum_minutes += Number(row.delivery_sum_minutes || 0);
      acc.delivery_count += Number(row.delivery_count || 0);

      acc.e2e_sum_minutes += Number(row.e2e_sum_minutes || 0);
      acc.e2e_count += Number(row.e2e_count || 0);

      acc.promise_sum_minutes += Number(row.promise_sum_minutes || 0);
      acc.promise_count += Number(row.promise_count || 0);

      acc.on_time_orders += Number(row.on_time_orders || 0);
      acc.on_time_eligible_orders += Number(row.on_time_eligible_orders || 0);
    }

    const result = Array.from(grouped.values())
      .map((row) => ({
        business_date: row.business_date,
        store_uuid: row.store_uuid,
        store_name: row.store_name,
        orders_total: row.orders_total,
        delivered_orders: row.delivered_orders,
        active_orders: row.active_orders,
        cancelled_orders: row.cancelled_orders,
        pick_minutes: row.pick_count ? row.pick_sum_minutes / row.pick_count : null,
        delivery_minutes: row.delivery_count ? row.delivery_sum_minutes / row.delivery_count : null,
        e2e_minutes: row.e2e_count ? row.e2e_sum_minutes / row.e2e_count : null,
        promise_minutes: row.promise_count ? row.promise_sum_minutes / row.promise_count : null,
        on_time_pct: row.on_time_eligible_orders
          ? (row.on_time_orders / row.on_time_eligible_orders) * 100
          : null,
      }))
      .sort((a, b) => String(a.store_name || "").localeCompare(String(b.store_name || ""), "es"));

    return json({
      ok: true,
      business_date: businessDate,
      cutoff_time: cutoffTime,
      data: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      message === "Missing bearer token" || message === "Invalid or expired session"
        ? 401
        : message === "Inactive user" ||
            message === "Profile not found" ||
            message === "Access denied: admin role required"
          ? 403
          : 500;

    return json(
      {
        ok: false,
        error: message,
      },
      status
    );
  }
});
