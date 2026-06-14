import { createClient } from 'npm:@supabase/supabase-js@2'

function isValidIsoDate(value: string | null): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function todayIsoInChile(): string {
  const now = new Date()
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return formatter.format(now)
}

function isValidTime(value: string | null): value is string {
  return !!value && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value)
}

function timeToMinutes(value: string): number {
  const [h, m] = value.split(':').map(Number)
  return h * 60 + m
}

function currentMinuteOfDayInChile(): number {
  const now = new Date()
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Santiago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

  const [hour, minute] = formatter.format(now).split(':').map(Number)
  return hour * 60 + minute
}

function parseDate(value: string | null): Date | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date
}

function calculateActiveMinutes(
  row: OrderRow,
  now: Date,
  nowChileMinute: number
): number | null {
  const createdMinute = Number(row.created_minute_of_day)

  if (!Number.isNaN(createdMinute)) {
    let diff = nowChileMinute - createdMinute
    if (diff < 0) diff += 1440
    return diff
  }

  const createdAt = parseDate(row.created_at ?? null)

  if (createdAt) {
    const diff = Math.floor((now.getTime() - createdAt.getTime()) / 60000)

    if (Number.isFinite(diff) && diff >= 0 && diff <= 2880) {
      return diff
    }
  }

  return null
}

function calculatePromiseDeltaMinutes(
  row: OrderRow,
  now: Date,
  activeMinutes: number | null
): number | null {
  if (row.promise_minutes !== null && row.promise_minutes !== undefined && activeMinutes !== null) {
    const promiseMinutes = Number(row.promise_minutes)
    if (!Number.isNaN(promiseMinutes)) {
      return Math.round(promiseMinutes - activeMinutes)
    }
  }

  const promisedAt = parseDate(row.promised_delivery_time_at ?? null)

  if (promisedAt) {
    const diff = Math.floor((promisedAt.getTime() - now.getTime()) / 60000)

    if (Number.isFinite(diff) && diff >= -2880 && diff <= 2880) {
      return diff
    }
  }

  return null
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


function shouldShowInActiveOrdersPanel(status: string | null): boolean {
  const normalized = String(status || '').trim().toLowerCase()

  // Las órdenes retiradas siguen contando como activas hasta ser entregadas,
  // pero no se muestran en el recuadro de seguimiento operativo de tienda.
  return normalized !== 'collected' && normalized !== 'retirada'
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

type AppRole = 'store_user' | 'supervisor' | 'manager' | 'admin'

type UserAccess = {
  userId: string
  role: AppRole
  active: boolean
  allowedStoreUuids: string[]
}

type OrderRow = {
  order_uuid: string
  order_partners_unique_internal_order_id: string | null
  business_date: string
  store_uuid: string
  store_name: string
  completed_flag: boolean | null
  delivery_status: string | null
  created_at: string | null
  collected_at: string | null
  delivered_at: string | null
  promised_delivery_time_at: string | null
  pick_minutes: number | null
  delivery_minutes: number | null
  e2e_minutes: number | null
  promise_minutes: number | null
  on_time_flag: boolean | null
  created_hour: number | null
  created_minute_of_day: number | null
}

type ActiveOrderDetail = {
  order_uuid: string
  order_partners_unique_internal_order_id: string | null
  business_date: string
  store_uuid: string
  store_name: string
  delivery_status: string | null
  created_at: string | null
  created_minute_of_day: number | null
  collected_at: string | null
  promised_delivery_time_at: string | null
  active_minutes: number | null
  promise_minutes: number | null
  promise_delta_minutes: number | null
}

function compareActiveOrders(a: ActiveOrderDetail, b: ActiveOrderDetail): number {
  const aDelta = a.promise_delta_minutes === null
    ? Number.POSITIVE_INFINITY
    : Number(a.promise_delta_minutes)
  const bDelta = b.promise_delta_minutes === null
    ? Number.POSITIVE_INFINITY
    : Number(b.promise_delta_minutes)

  if (aDelta !== bDelta) return aDelta - bDelta

  const aMinutes = a.active_minutes === null ? -1 : Number(a.active_minutes)
  const bMinutes = b.active_minutes === null ? -1 : Number(b.active_minutes)

  return bMinutes - aMinutes
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
          mode: 'live_by_time',
          business_date: null,
          time_start: null,
          time_end: null,
          count_orders: 0,
          count_stores: 0,
          deliveries_total: 0,
          delivered_orders: 0,
          active_orders: 0,
          cancelled_orders: 0,
          active_orders_summary: {
            total_active_orders: 0,
            oldest_active_minutes: null,
            oldest_active_store_name: null,
            oldest_active_order_uuid: null,
            oldest_active_order_partner_id: null,
            oldest_active_promise_delta_minutes: null,
            warning_active_orders: 0,
            critical_active_orders: 0,
            overdue_active_orders: 0,
          },
          active_orders_detail: [],
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
    const timeStartParam = url.searchParams.get('time_start')
    const timeEndParam = url.searchParams.get('time_end')

    const businessDate = isValidIsoDate(businessDateParam)
      ? businessDateParam
      : todayIsoInChile()

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
          order_partners_unique_internal_order_id,
          business_date,
          store_uuid,
          store_name,
          completed_flag,
          delivery_status,
          created_at,
          collected_at,
          delivered_at,
          promised_delivery_time_at,
          pick_minutes,
          delivery_minutes,
          e2e_minutes,
          promise_minutes,
          on_time_flag,
          created_hour,
          created_minute_of_day
        `)
        .eq('business_date', businessDate)
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
    const activeOrdersDetail: ActiveOrderDetail[] = []
    const now = new Date()
    const nowChileMinute = currentMinuteOfDayInChile()

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
          oldest_active_minutes: null,
          oldest_active_order_uuid: null,
          oldest_active_promise_delta_minutes: null,
          oldest_active_status: null,
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

        const activeMinutes = calculateActiveMinutes(row, now, nowChileMinute)
        const promiseDeltaMinutes = calculatePromiseDeltaMinutes(row, now, activeMinutes)
        const rawPromiseMinutes = row.promise_minutes === null || row.promise_minutes === undefined
          ? null
          : Number(row.promise_minutes)
        const promiseMinutes = rawPromiseMinutes !== null && !Number.isNaN(rawPromiseMinutes)
          ? rawPromiseMinutes
          : null

        activeOrdersDetail.push({
          order_uuid: row.order_uuid,
          order_partners_unique_internal_order_id: row.order_partners_unique_internal_order_id ?? null,
          business_date: row.business_date,
          store_uuid: row.store_uuid,
          store_name: row.store_name,
          delivery_status: row.delivery_status,
          created_at: row.created_at,
          created_minute_of_day: row.created_minute_of_day,
          collected_at: row.collected_at,
          promised_delivery_time_at: row.promised_delivery_time_at,
          active_minutes: activeMinutes,
          promise_minutes: promiseMinutes,
          promise_delta_minutes: promiseDeltaMinutes,
        })

        if (
          activeMinutes !== null &&
          (
            item.oldest_active_minutes === null ||
            activeMinutes > item.oldest_active_minutes
          )
        ) {
          item.oldest_active_minutes = activeMinutes
          item.oldest_active_order_uuid = row.order_uuid
          item.oldest_active_promise_delta_minutes = promiseDeltaMinutes
          item.oldest_active_status = row.delivery_status
        }
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
        oldest_active_minutes: item.oldest_active_minutes,
        oldest_active_order_uuid: item.oldest_active_order_uuid,
        oldest_active_promise_delta_minutes: item.oldest_active_promise_delta_minutes,
        oldest_active_status: item.oldest_active_status,
        pick_minutes: item.pick_count ? item.pick_sum / item.pick_count : null,
        delivery_minutes: item.delivery_count ? item.delivery_sum / item.delivery_count : null,
        e2e_minutes: item.e2e_count ? item.e2e_sum / item.e2e_count : null,
        promise_minutes: item.promise_count ? item.promise_sum / item.promise_count : null,
        on_time_pct: item.on_time_count ? (item.on_time_total / item.on_time_count) * 100 : null,
      }))
      .sort((a, b) => a.store_name.localeCompare(b.store_name, 'es'))

    const totalDeliveries = summaryByStore.reduce(
      (sum, row) => sum + (Number(row.deliveries_total) || 0),
      0
    )

    const totalDeliveredOrders = summaryByStore.reduce(
      (sum, row) => sum + (Number(row.delivered_orders) || 0),
      0
    )

    const totalActiveOrders = summaryByStore.reduce(
      (sum, row) => sum + (Number(row.active_orders) || 0),
      0
    )

    const totalCancelledOrders = summaryByStore.reduce(
      (sum, row) => sum + (Number(row.cancelled_orders) || 0),
      0
    )

    const activeOrdersForPanel = activeOrdersDetail.filter(order =>
      shouldShowInActiveOrdersPanel(order.delivery_status)
    )

    const activeOrdersByRisk = [...activeOrdersForPanel].sort(compareActiveOrders)
    const activeOrdersByAge = [...activeOrdersDetail]
      .filter(order => order.active_minutes !== null)
      .sort((a, b) => Number(b.active_minutes) - Number(a.active_minutes))

    const oldestActiveOrder = activeOrdersByAge[0] || null

    const activeOrdersSummary = {
      total_active_orders: totalActiveOrders,
      oldest_active_minutes: oldestActiveOrder?.active_minutes ?? null,
      oldest_active_store_name: oldestActiveOrder?.store_name ?? null,
      oldest_active_order_uuid: oldestActiveOrder?.order_uuid ?? null,
      oldest_active_order_partner_id: oldestActiveOrder?.order_partners_unique_internal_order_id ?? null,
      oldest_active_promise_delta_minutes: oldestActiveOrder?.promise_delta_minutes ?? null,
      warning_active_orders: activeOrdersDetail.filter(order => {
        const minutes = Number(order.active_minutes)
        return !Number.isNaN(minutes) && minutes >= 31 && minutes < 41
      }).length,
      critical_active_orders: activeOrdersDetail.filter(order => {
        const minutes = Number(order.active_minutes)
        return !Number.isNaN(minutes) && minutes >= 41
      }).length,
      overdue_active_orders: activeOrdersDetail.filter(order => {
        const delta = Number(order.promise_delta_minutes)
        return !Number.isNaN(delta) && delta < 0
      }).length,
    }

    return new Response(
      JSON.stringify({
        ok: true,
        mode: 'live_by_time',
        business_date: businessDate,
        time_start: timeStart,
        time_end: timeEnd,
        count_orders: rows.length,
        count_stores: summaryByStore.length,
        deliveries_total: totalDeliveries,
        delivered_orders: totalDeliveredOrders,
        active_orders: totalActiveOrders,
        cancelled_orders: totalCancelledOrders,
        active_orders_summary: activeOrdersSummary,
        active_orders_detail: activeOrdersByRisk.slice(0, 100),
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
