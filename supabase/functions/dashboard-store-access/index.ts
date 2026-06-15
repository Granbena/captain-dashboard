import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, PUT, PATCH, OPTIONS",
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

type StoreAccessPayload = {
  supervisorId: string;
  storeUuids: string[];
};

type SupervisorActivePayload = {
  supervisorId: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStoreUuid(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Invalid storeUuids payload");
  }

  const normalized = value.trim();

  if (!normalized) {
    throw new Error("Invalid storeUuids payload");
  }

  return normalized;
}

function parseStoreAccessPayload(body: unknown): StoreAccessPayload {
  if (!isRecord(body)) {
    throw new Error("Invalid JSON body");
  }

  const supervisorId = typeof body.supervisorId === "string"
    ? body.supervisorId.trim()
    : "";

  if (!supervisorId) {
    throw new Error("Invalid supervisorId");
  }

  if (!Array.isArray(body.storeUuids)) {
    throw new Error("Invalid storeUuids payload");
  }

  return {
    supervisorId,
    storeUuids: [...new Set(body.storeUuids.map(normalizeStoreUuid))],
  };
}

function parseSupervisorActivePayload(body: unknown): SupervisorActivePayload {
  if (!isRecord(body)) {
    throw new Error("Invalid JSON body");
  }

  const supervisorId = typeof body.supervisorId === "string"
    ? body.supervisorId.trim()
    : "";

  if (!supervisorId) {
    throw new Error("Invalid supervisorId");
  }

  if (typeof body.active !== "boolean") {
    throw new Error("Invalid active payload");
  }

  return {
    supervisorId,
    active: body.active,
  };
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

  const { data: userData, error: userError } = await authClient.auth.getUser();

  if (userError || !userData.user) {
    throw new Error("Invalid or expired session");
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
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

async function readStoreAccessConfig(adminClient: ReturnType<typeof createClient>) {
  const [
    supervisorsResult,
    storesResult,
    assignmentsResult,
  ] = await Promise.all([
    adminClient
      .from("profiles")
      .select("id, email, full_name, role, active, is_active")
      .eq("role", "supervisor")
      .order("email", { ascending: true }),
    adminClient
      .from("store_business_rules")
      .select("store_uuid, store_name, active")
      .eq("active", true)
      .order("store_name", { ascending: true }),
    adminClient
      .from("user_store_access")
      .select("user_id, store_uuid"),
  ]);

  if (supervisorsResult.error) {
    throw new Error(`Error reading supervisors: ${supervisorsResult.error.message}`);
  }

  if (storesResult.error) {
    throw new Error(`Error reading stores: ${storesResult.error.message}`);
  }

  if (assignmentsResult.error) {
    throw new Error(`Error reading assignments: ${assignmentsResult.error.message}`);
  }

  return {
    supervisors: supervisorsResult.data || [],
    stores: storesResult.data || [],
    assignments: assignmentsResult.data || [],
  };
}

async function validateSupervisor(
  adminClient: ReturnType<typeof createClient>,
  supervisorId: string
) {
  const { data: supervisor, error } = await adminClient
    .from("profiles")
    .select("id, role")
    .eq("id", supervisorId)
    .maybeSingle();

  if (error) {
    throw new Error(`Error reading supervisor: ${error.message}`);
  }

  if (!supervisor) {
    throw new Error("Supervisor not found");
  }

  if (supervisor.role !== "supervisor") {
    throw new Error("Selected user is not a supervisor");
  }
}

async function validateActiveStores(
  adminClient: ReturnType<typeof createClient>,
  storeUuids: string[]
) {
  if (storeUuids.length === 0) return;

  const { data: stores, error } = await adminClient
    .from("store_business_rules")
    .select("store_uuid")
    .eq("active", true)
    .in("store_uuid", storeUuids);

  if (error) {
    throw new Error(`Error reading stores: ${error.message}`);
  }

  const foundStoreUuids = new Set((stores || []).map((store) => store.store_uuid));
  const missingStoreUuids = storeUuids.filter((storeUuid) => !foundStoreUuids.has(storeUuid));

  if (missingStoreUuids.length > 0) {
    throw new Error(`Invalid or inactive stores: ${missingStoreUuids.join(", ")}`);
  }
}

async function replaceSupervisorAssignments(
  adminClient: ReturnType<typeof createClient>,
  supervisorId: string,
  storeUuids: string[]
) {
  const { error: deleteError } = await adminClient
    .from("user_store_access")
    .delete()
    .eq("user_id", supervisorId);

  if (deleteError) {
    throw new Error(`Error deleting assignments: ${deleteError.message}`);
  }

  if (storeUuids.length > 0) {
    const rows = storeUuids.map((storeUuid) => ({
      user_id: supervisorId,
      store_uuid: storeUuid,
    }));

    const { error: insertError } = await adminClient
      .from("user_store_access")
      .insert(rows);

    if (insertError) {
      throw new Error(`Error saving assignments: ${insertError.message}`);
    }
  }

  const { data: assignments, error: readError } = await adminClient
    .from("user_store_access")
    .select("user_id, store_uuid")
    .eq("user_id", supervisorId)
    .order("store_uuid", { ascending: true });

  if (readError) {
    throw new Error(`Error reading updated assignments: ${readError.message}`);
  }

  return assignments || [];
}

async function updateSupervisorActiveState(
  adminClient: ReturnType<typeof createClient>,
  supervisorId: string,
  active: boolean
) {
  const { data: supervisor, error } = await adminClient
    .from("profiles")
    .update({
      active,
      is_active: active,
    })
    .eq("id", supervisorId)
    .eq("role", "supervisor")
    .select("id, email, full_name, role, active, is_active")
    .maybeSingle();

  if (error) {
    throw new Error(`Error updating supervisor: ${error.message}`);
  }

  if (!supervisor) {
    throw new Error("Supervisor not found");
  }

  return supervisor;
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

  if (message === "Supervisor not found") {
    return 404;
  }

  if (
    message === "Invalid JSON body" ||
    message === "Invalid supervisorId" ||
    message === "Invalid active payload" ||
    message === "Invalid storeUuids payload" ||
    message === "Selected user is not a supervisor" ||
    message.startsWith("Invalid or inactive stores")
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

    await getAdminUser(req, supabaseUrl, anonKey, serviceRoleKey);

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (req.method === "GET") {
      const data = await readStoreAccessConfig(adminClient);
      return json({ ok: true, ...data });
    }

    if (req.method === "PUT") {
      const body = await req.json().catch(() => {
        throw new Error("Invalid JSON body");
      });
      const payload = parseStoreAccessPayload(body);

      await validateSupervisor(adminClient, payload.supervisorId);
      await validateActiveStores(adminClient, payload.storeUuids);

      const assignments = await replaceSupervisorAssignments(
        adminClient,
        payload.supervisorId,
        payload.storeUuids
      );

      return json({ ok: true, supervisorId: payload.supervisorId, assignments });
    }

    if (req.method === "PATCH") {
      const body = await req.json().catch(() => {
        throw new Error("Invalid JSON body");
      });
      const payload = parseSupervisorActivePayload(body);

      await validateSupervisor(adminClient, payload.supervisorId);
      const supervisor = await updateSupervisorActiveState(
        adminClient,
        payload.supervisorId,
        payload.active
      );

      return json({ ok: true, supervisor });
    }

    return json({ ok: false, error: "Method not allowed" }, 405);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, errorStatus(message));
  }
});
