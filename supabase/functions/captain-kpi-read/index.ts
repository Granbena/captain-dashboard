import { createClient } from 'npm:@supabase/supabase-js@2'

function isValidIsoDate(value: string | null): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function isValidTime(value: string | null): value is string {
  return !!value && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value)
}

function timeToMinutes(value: string): number {
  const [h, m] = value.split(':').map(Number)
  return h * 60 + m
}

function classifyDeliveryStatus(
  status: string | null,
  deliveredAt: string | null
): 'delivered' | 'cancelled' | 'active' {
  const normalized = String(status || '').trim().toLowerCase()

  if (deliveredAt) return 'delivered'
  if (normalized === 'completed' || normalized === 'dropped_off') return 'delivered'
  if (normalized === 'cancelled' || normalized === 'unassigned_to_driver') return 'cancelled'

  if (
    normalized === 'assigned_and_accepted_by_driver' ||
    normalized === 'assigned_to_driver' ||
    normalized === 'collected'
  ) {
    return 'active'
  }

  return 'active'
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
}

type OrderRow = {
  order_uuid: string
  business_date: string
  store_uuid: string
  store_name: string
  completed_flag: boolean | null
  delivery_status: string | null
  delivered_at: string | null
  pick_minutes: number | null
  delivery_minutes: number | null
  e2e_minutes: number | null
  promise_minutes: number | null
  on_time_flag: boolean | null
  created_minute_of_day: number | null
}

type AppRole = 'store_user' | 'supervisor' | 'manager' | 'admin'

type UserAccess = {
  userId: string
  role: AppRole
  active: boolean
  allowedStoreUuids: string[]
}

async function getUserAccess(
  req: Request,
  supabaseUrl: string,
  anonKey: string,
  serviceRoleKey: string
): Promise<UserAccess> {
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization')

  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing bearer token')
  }

  const token = authHeader.replace('Bearer ', '').trim()

  const authClient = createClient(supabaseUrl, anonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  })

  const adminClient = createClient(supabaseUrl, serviceRoleKey)

  const { data: userData, error: userError } = await authClient.auth.getUser()

  if (userError || !userData.user) {
    throw new Error('Invalid or expired session')
  }

  const userId = userData.user.id

  const { data: profile, error: profileError } = await adminClient
    .from('profiles')
    .select('id, role, active')
    .eq('id', userId)
    .maybeSingle()

  if (profileError) {
    throw new Error(`Error reading profile: ${profileError.message}`)
  }

  if (!profile) {
    throw new Error('Profile not found')
  }

  if (!profile.active) {
    throw new Error('Inactive user')
  }

  const role = profile.role as AppRole

  if (role !== 'admin') {
    throw new Error('Access denied: admin role required')
  }

  return {
    userId,
    role,
    active: true,
    allowedStoreUuids: [],
  }
}

function emptySummary() {
  return {
    orders_total: 0,
    deliveries_total: 0,
    delivered_orders: 0,
    active_orders: 0,
    cancelled_orders: 0,

    on_time_pct: null,
    e2e_minutes: null,
    pick_minutes: null,
    collection_minutes: null,
    delivery_minutes: null,
    trip_minutes: null,
    promise_minutes: null,
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)

    const userAccess = await getUserAccess(
      req,
      supabaseUrl,
      supabaseAnonKey,
      supabaseServiceRoleKey
    )

    const isFullAccess =
      userAccess.role === 'admin'

    if (!isFullAccess && userAccess.allowedStoreUuids.length === 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          mode: 'latest',
          latest_business_date: null,
          requested_business_date: null,
          requested_date_start: null,
          requested_date_end: null,
          time_start: null,
          time_end: null,
          count: 0,
          count_orders: 0,
          delivered_orders: 0,
          active_orders: 0,
          cancelled_orders: 0,
          summary: emptySummary(),
          data: [],
        }),
        {
          headers: corsHeaders,
          status: 200,
        }
      )
    }

    const url = new URL(req.url)
    const businessDateParam = url.searchParams.get('business_date')
    const dateStartParam = url.searchParams.get('date_start')
    const dateEndParam = url.searchParams.get('date_end')
    const timeStartParam = url.searchParams.get('time_start')
    const timeEndParam = url.searchParams.get('time_end')

    let mode: 'latest' | 'single_day' | 'range' = 'latest'
    let latestBusinessDate: string | null = null

    let dateStart: string
    let dateEnd: string

    if (isValidIsoDate(businessDateParam)) {
      mode = 'single_day'
      dateStart = businessDateParam
      dateEnd = businessDateParam
    } else if (isValidIsoDate(dateStartParam) && isValidIsoDate(dateEndParam)) {
      if (dateStartParam > dateEndParam) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: 'date_start cannot be greater than date_end',
          }),
          {
            headers: corsHeaders,
            status: 400,
          }
        )
      }

      mode = dateStartParam === dateEndParam ? 'single_day' : 'range'
      dateStart = dateStartParam
      dateEnd = dateEndParam
    } else {
      let latestQuery = supabase
        .from('kpi_orders')
        .select('business_date')
        .order('business_date', { ascending: false })
        .limit(1)

      if (!isFullAccess) {
        latestQuery = latestQuery.in('store_uuid', userAccess.allowedStoreUuids)
      }

      const { data: latestRow, error: latestError } = await latestQuery.maybeSingle()

      if (latestError) {
        return new Response(
          JSON.stringify({
            ok: false,
            step: 'get_latest_business_date',
            error: latestError,
          }),
          {
            headers: corsHeaders,
            status: 200,
          }
        )
      }

      if (!latestRow?.business_date) {
        return new Response(
          JSON.stringify({
            ok: true,
            mode: 'latest',
            latest_business_date: null,
            requested_business_date: null,
            requested_date_start: null,
            requested_date_end: null,
            time_start: null,
            time_end: null,
            count: 0,
            count_orders: 0,
            delivered_orders: 0,
            active_orders: 0,
            cancelled_orders: 0,
            summary: emptySummary(),
            data: [],
          }),
          {
            headers: corsHeaders,
            status: 200,
          }
        )
      }

      latestBusinessDate = latestRow.business_date
      dateStart = latestBusinessDate
      dateEnd = latestBusinessDate
    }

    const timeStart = isValidTime(timeStartParam) ? timeStartParam : null
    const timeEnd = isValidTime(timeEndParam) ? timeEndParam : null

    let allRows: OrderRow[] = []
    let from = 0
    const pageSize = 1000

    while (true) {
      let query = supabase
        .from('kpi_orders')
        .select(`
          order_uuid,
          business_date,
          store_uuid,
          store_name,
          completed_flag,
          delivery_status,
          delivered_at,
          pick_minutes,
          delivery_minutes,
          e2e_minutes,
          promise_minutes,
          on_time_flag,
          created_minute_of_day
        `)
        .gte('business_date', dateStart)
        .lte('business_date', dateEnd)
        .order('business_date', { ascending: true })
        .order('store_name', { ascending: true })
        .range(from, from + pageSize - 1)

      if (!isFullAccess) {
        query = query.in('store_uuid', userAccess.allowedStoreUuids)
      }

      const { data, error } = await query

      if (error) {
        return new Response(
          JSON.stringify({
            ok: false,
            step: 'read_kpi_orders',
            error,
          }),
          {
            headers: corsHeaders,
            status: 500,
          }
        )
      }

      if (!data || data.length === 0) break

      allRows = allRows.concat(data as OrderRow[])

      if (data.length < pageSize) break
      from += pageSize
    }

    let rows = allRows

    if (timeStart && timeEnd) {
      const startMin = timeToMinutes(timeStart)
      const endMin = timeToMinutes(timeEnd)
      const crossesMidnight = endMin < startMin

      rows = rows.filter(row => {
        const rowMinutes = Number(row.created_minute_of_day)
        if (Number.isNaN(rowMinutes)) return false

        if (crossesMidnight) {
          return rowMinutes >= startMin || rowMinutes <= endMin
        }

        return rowMinutes >= startMin && rowMinutes <= endMin
      })
    }

    const grouped = new Map<string, any>()

    for (const row of rows) {
      const key = `${row.business_date}_${row.store_uuid}`

      if (!grouped.has(key)) {
        grouped.set(key, {
          business_date: row.business_date,
          store_uuid: row.store_uuid,
          store_name: row.store_name,

          orders_total: 0,
          deliveries_total: 0,
          delivered_orders: 0,
          active_orders: 0,
          cancelled_orders: 0,

          pick_sum: 0,
          pick_count: 0,

          delivery_sum: 0,
          delivery_count: 0,

          e2e_sum: 0,
          e2e_count: 0,

          promise_sum: 0,
          promise_count: 0,

          on_time_total: 0,
          on_time_count: 0,
        })
      }

      const item = grouped.get(key)
      item.orders_total++

      const statusBucket = classifyDeliveryStatus(
        row.delivery_status ?? null,
        row.delivered_at ?? null
      )

      if (statusBucket === 'delivered') {
        item.deliveries_total++
        item.delivered_orders++
      } else if (statusBucket === 'cancelled') {
        item.cancelled_orders++
      } else {
        item.active_orders++
      }

      const pick = Number(row.pick_minutes)
      if (!Number.isNaN(pick) && row.pick_minutes !== null) {
        item.pick_sum += pick
        item.pick_count++
      }

      const delivery = Number(row.delivery_minutes)
      if (!Number.isNaN(delivery) && row.delivery_minutes !== null) {
        item.delivery_sum += delivery
        item.delivery_count++
      }

      const e2e = Number(row.e2e_minutes)
      if (!Number.isNaN(e2e) && row.e2e_minutes !== null) {
        item.e2e_sum += e2e
        item.e2e_count++
      }

      const promise = Number(row.promise_minutes)
      if (!Number.isNaN(promise) && row.promise_minutes !== null) {
        item.promise_sum += promise
        item.promise_count++
      }

      if (row.on_time_flag === true || row.on_time_flag === false) {
        item.on_time_count++
        if (row.on_time_flag === true) {
          item.on_time_total++
        }
      }
    }

    const summaryByStore = Array.from(grouped.values())
      .map(item => ({
        business_date: item.business_date,
        store_uuid: item.store_uuid,
        store_name: item.store_name,

        orders_total: item.orders_total,
        deliveries_total: item.deliveries_total,
        delivered_orders: item.delivered_orders,
        active_orders: item.active_orders,
        cancelled_orders: item.cancelled_orders,

        pick_minutes: item.pick_count ? item.pick_sum / item.pick_count : null,
        collection_minutes: item.pick_count ? item.pick_sum / item.pick_count : null,

        delivery_minutes: item.delivery_count ? item.delivery_sum / item.delivery_count : null,
        trip_minutes: item.delivery_count ? item.delivery_sum / item.delivery_count : null,

        e2e_minutes: item.e2e_count ? item.e2e_sum / item.e2e_count : null,
        promise_minutes: item.promise_count ? item.promise_sum / item.promise_count : null,

        on_time_pct: item.on_time_count
          ? (item.on_time_total / item.on_time_count) * 100
          : null,
      }))
      .sort((a, b) => {
        if (a.business_date !== b.business_date) {
          return a.business_date.localeCompare(b.business_date)
        }
        return a.store_name.localeCompare(b.store_name, 'es')
      })

    const globalTotals = Array.from(grouped.values()).reduce(
      (acc, item) => {
        acc.orders_total += Number(item.orders_total) || 0
        acc.deliveries_total += Number(item.deliveries_total) || 0
        acc.delivered_orders += Number(item.delivered_orders) || 0
        acc.active_orders += Number(item.active_orders) || 0
        acc.cancelled_orders += Number(item.cancelled_orders) || 0

        acc.pick_sum += Number(item.pick_sum) || 0
        acc.pick_count += Number(item.pick_count) || 0

        acc.delivery_sum += Number(item.delivery_sum) || 0
        acc.delivery_count += Number(item.delivery_count) || 0

        acc.e2e_sum += Number(item.e2e_sum) || 0
        acc.e2e_count += Number(item.e2e_count) || 0

        acc.promise_sum += Number(item.promise_sum) || 0
        acc.promise_count += Number(item.promise_count) || 0

        acc.on_time_total += Number(item.on_time_total) || 0
        acc.on_time_count += Number(item.on_time_count) || 0

        return acc
      },
      {
        orders_total: 0,
        deliveries_total: 0,
        delivered_orders: 0,
        active_orders: 0,
        cancelled_orders: 0,

        pick_sum: 0,
        pick_count: 0,

        delivery_sum: 0,
        delivery_count: 0,

        e2e_sum: 0,
        e2e_count: 0,

        promise_sum: 0,
        promise_count: 0,

        on_time_total: 0,
        on_time_count: 0,
      }
    )

    const summary = {
      orders_total: globalTotals.orders_total,
      deliveries_total: globalTotals.deliveries_total,
      delivered_orders: globalTotals.delivered_orders,
      active_orders: globalTotals.active_orders,
      cancelled_orders: globalTotals.cancelled_orders,

      on_time_pct:
        globalTotals.on_time_count > 0
          ? (globalTotals.on_time_total / globalTotals.on_time_count) * 100
          : null,

      e2e_minutes:
        globalTotals.e2e_count > 0
          ? globalTotals.e2e_sum / globalTotals.e2e_count
          : null,

      pick_minutes:
        globalTotals.pick_count > 0
          ? globalTotals.pick_sum / globalTotals.pick_count
          : null,

      collection_minutes:
        globalTotals.pick_count > 0
          ? globalTotals.pick_sum / globalTotals.pick_count
          : null,

      delivery_minutes:
        globalTotals.delivery_count > 0
          ? globalTotals.delivery_sum / globalTotals.delivery_count
          : null,

      trip_minutes:
        globalTotals.delivery_count > 0
          ? globalTotals.delivery_sum / globalTotals.delivery_count
          : null,

      promise_minutes:
        globalTotals.promise_count > 0
          ? globalTotals.promise_sum / globalTotals.promise_count
          : null,
    }

    return new Response(
      JSON.stringify({
        ok: true,
        mode,
        latest_business_date: latestBusinessDate,
        requested_business_date: isValidIsoDate(businessDateParam) ? businessDateParam : null,
        requested_date_start: isValidIsoDate(dateStartParam) ? dateStartParam : null,
        requested_date_end: isValidIsoDate(dateEndParam) ? dateEndParam : null,
        time_start: timeStart,
        time_end: timeEnd,

        count: summaryByStore.length,
        count_orders: summary.orders_total,
        delivered_orders: summary.delivered_orders,
        active_orders: summary.active_orders,
        cancelled_orders: summary.cancelled_orders,

        summary,
        data: summaryByStore,
      }),
      {
        headers: corsHeaders,
        status: 200,
      }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: String(error),
      }),
      {
        headers: corsHeaders,
        status: 401,
      }
    )
  }
})