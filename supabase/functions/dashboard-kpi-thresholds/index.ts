import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  "Pragma": "no-cache",
  "Expires": "0",
};

type AppRole = "store_user" | "supervisor" | "admin";

type UserAccess = {
  userId: string;
  role: AppRole;
  active: boolean;
};

type MetricDefinition = {
  label: string;
  unit: "percent" | "minutes";
  direction: "higher_is_better" | "lower_is_better";
  sortOrder: number;
};

const METRIC_DEFINITIONS = {
  onTime: {
    label: "OnTime",
    unit: "percent",
    direction: "higher_is_better",
    sortOrder: 10,
  },
  e2e: {
    label: "E2E",
    unit: "minutes",
    direction: "lower_is_better",
    sortOrder: 20,
  },
  pick: {
    label: "Pick",
    unit: "minutes",
    direction: "lower_is_better",
    sortOrder: 30,
  },
  delivery: {
    label: "Delivery",
    unit: "minutes",
    direction: "lower_is_better",
    sortOrder: 40,
  },
  activeAge: {
    label: "Activas/antigüedad",
    unit: "minutes",
    direction: "lower_is_better",
    sortOrder: 50,
  },
} satisfies Record<string, MetricDefinition>;

type MetricKey = keyof typeof METRIC_DEFINITIONS;
type ThresholdValues = Record<string, number>;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  const num = Number(value);

  if ((typeof value !== "number" && typeof value !== "string") || !Number.isFinite(num)) {
    throw new Error(`Invalid numeric threshold: ${key}`);
  }

  return num;
}

async function getAdminUser(
  req: Request,
  supabaseUrl: string,
  anonKey: string,
  serviceRoleKey: string
): Promise<UserAccess> {
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");

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

function validateMetricThresholds(metricKey: MetricKey, rawValue: unknown): ThresholdValues {
  if (!isRecord(rawValue)) {
    throw new Error(`Missing thresholds for ${metricKey}`);
  }

  if (metricKey === "onTime") {
    const redBelow = readNumber(rawValue, "redBelow");
    const yellowBelow = readNumber(rawValue, "yellowBelow");
    const greenMin = readNumber(rawValue, "greenMin");

    if (!(redBelow < yellowBelow && yellowBelow <= greenMin)) {
      throw new Error("Invalid onTime thresholds: expected redBelow < yellowBelow <= greenMin");
    }

    return { redBelow, yellowBelow, greenMin };
  }

  if (metricKey === "e2e") {
    const greenMax = readNumber(rawValue, "greenMax");
    const yellowAbove = readNumber(rawValue, "yellowAbove");
    const redAbove = readNumber(rawValue, "redAbove");

    if (!(greenMax <= yellowAbove && yellowAbove < redAbove)) {
      throw new Error("Invalid e2e thresholds: expected greenMax <= yellowAbove < redAbove");
    }

    return { greenMax, yellowAbove, redAbove };
  }

  if (metricKey === "activeAge") {
    const greenBelow = readNumber(rawValue, "greenBelow");
    const yellowMin = readNumber(rawValue, "yellowMin");
    const redMin = readNumber(rawValue, "redMin");

    if (!(greenBelow <= yellowMin && yellowMin < redMin)) {
      throw new Error("Invalid activeAge thresholds: expected greenBelow <= yellowMin < redMin");
    }

    return { greenBelow, yellowMin, redMin };
  }

  const greenBelow = readNumber(rawValue, "greenBelow");
  const yellowMin = readNumber(rawValue, "yellowMin");
  const redAbove = readNumber(rawValue, "redAbove");

  if (!(greenBelow <= yellowMin && yellowMin < redAbove)) {
    throw new Error(`Invalid ${metricKey} thresholds: expected greenBelow <= yellowMin < redAbove`);
  }

  return { greenBelow, yellowMin, redAbove };
}

function buildUpsertRows(body: unknown, userId: string) {
  if (!isRecord(body) || !isRecord(body.thresholds)) {
    throw new Error("Missing thresholds object");
  }

  const rows = Object.keys(body.thresholds).map((key) => {
    if (!(key in METRIC_DEFINITIONS)) {
      throw new Error(`Unknown KPI metric: ${key}`);
    }

    const metricKey = key as MetricKey;
    const definition = METRIC_DEFINITIONS[metricKey];

    return {
      metric_key: metricKey,
      label: definition.label,
      unit: definition.unit,
      direction: definition.direction,
      thresholds: validateMetricThresholds(metricKey, body.thresholds[key]),
      sort_order: definition.sortOrder,
      active: true,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };
  });

  if (!rows.length) {
    throw new Error("No thresholds provided");
  }

  return rows;
}

async function readThresholds(adminClient: ReturnType<typeof createClient>) {
  const { data, error } = await adminClient
    .from("dashboard_kpi_thresholds")
    .select("metric_key, label, unit, direction, thresholds, sort_order, active, updated_by, updated_at")
    .eq("active", true)
    .order("sort_order", { ascending: true });

  if (error) {
    throw new Error(`Error reading KPI thresholds: ${error.message}`);
  }

  return data ?? [];
}

function errorStatus(message: string) {
  if (message === "Missing bearer token" || message === "Invalid or expired session") {
    return 401;
  }

  if (
    message === "Inactive user" ||
    message === "Profile not found" ||
    message === "Access denied: admin role required"
  ) {
    return 403;
  }

  if (
    message === "Invalid JSON body" ||
    message.startsWith("Invalid ") ||
    message.startsWith("Missing thresholds") ||
    message.startsWith("Unknown KPI metric") ||
    message === "Missing thresholds object" ||
    message === "No thresholds provided"
  ) {
    return 400;
  }

  return 500;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return json({ ok: false, error: "Missing Supabase environment variables" }, 500);
    }

    const userAccess = await getAdminUser(req, supabaseUrl, anonKey, serviceRoleKey);
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (req.method === "GET") {
      const data = await readThresholds(adminClient);
      return json({ ok: true, data });
    }

    if (req.method === "POST" || req.method === "PUT") {
      const body = await req.json().catch(() => {
        throw new Error("Invalid JSON body");
      });

      const rows = buildUpsertRows(body, userAccess.userId);
      const { error } = await adminClient
        .from("dashboard_kpi_thresholds")
        .upsert(rows, { onConflict: "metric_key" });

      if (error) {
        throw new Error(`Error saving KPI thresholds: ${error.message}`);
      }

      const data = await readThresholds(adminClient);
      return json({ ok: true, data });
    }

    return json({ ok: false, error: "Method not allowed" }, 405);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, errorStatus(message));
  }
});
