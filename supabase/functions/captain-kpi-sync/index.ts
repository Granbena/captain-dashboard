import { createClient } from 'npm:@supabase/supabase-js@2'

type Row = {
  order_uuid: string
  order_partners_unique_internal_order_id?: string
  account_uuid: string
  status: string
  created_at: string
  collected_at: string
  delivered_at: string
  promised_delivery_time_at?: string
  promised_delivery_minutes?: string
  store_name: string
  delivery_status: string
  order_type?: string
}

type GroupedItem = {
  business_date: string
  store_uuid: string
  store_name: string
  orders_total: number
  deliveries_total: number
  order_uuids: Set<string>
  pick_sum: number
  pick_count: number
  delivery_sum: number
  delivery_count: number
  e2e_sum: number
  e2e_count: number
  promise_sum: number
  promise_count: number
  on_time_total: number
  on_time_count: number
}

type OrderRecord = {
  order_uuid: string
  order_partners_unique_internal_order_id: string | null
  business_date: string
  store_uuid: string
  store_name: string
  created_at: string | null
  collected_at: string | null
  delivered_at: string | null
  promised_delivery_time_at: string | null
  delivery_status: string | null
  order_type: string | null
  completed_flag: boolean
  pick_minutes: number | null
  delivery_minutes: number | null
  e2e_minutes: number | null
  promise_minutes: number | null
  on_time_flag: boolean | null
  created_hour: number | null
  created_minute_of_day: number | null
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: corsHeaders,
    status,
  })
}

type AppRole = 'store_user' | 'supervisor' | 'admin'

type UserAccess = {
  userId: string
  role: AppRole
  active: boolean
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
  }
}

function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    const next = line[i + 1]

    if (char === '"' && inQuotes && next === '"') {
      current += '"'
      i++
    } else if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === ',' && !inQuotes) {
      result.push(current)
      current = ''
    } else {
      current += char
    }
  }

  result.push(current)
  return result
}

function csvToObjects(csvText: string): Row[] {
  const lines = csvText.split('\n').filter(Boolean)
  if (lines.length < 2) return []

  const headers = parseCsvLine(lines[0]).map(h => h.trim())

  return lines.slice(1).map(line => {
    const values = parseCsvLine(line)
    const obj: Record<string, string> = {}

    headers.forEach((header, index) => {
      obj[header] = (values[index] || '').trim()
    })

    return obj as unknown as Row
  })
}

function getCsvHeaders(csvText: string): string[] {
  const firstLine = csvText.split('\n').find(Boolean)
  if (!firstLine) return []
  return parseCsvLine(firstLine).map(h => h.trim())
}

function minutesBetween(start?: string, end?: string, min = 0, max = 300): number | null {
  if (!start || !end) return null

  const startDate = new Date(start)
  const endDate = new Date(end)

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return null

  const minutes = (endDate.getTime() - startDate.getTime()) / 60000

  if (!Number.isFinite(minutes) || minutes < min || minutes > max) return null

  return minutes
}

function parseMinutes(value?: string, min = 0, max = 300): number | null {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  if (!Number.isFinite(num) || num < min || num > max) return null
  return num
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

function toChileBusinessDate(isoString?: string, fallback = ''): string {
  if (!isoString) return fallback

  const date = new Date(isoString)
  if (isNaN(date.getTime())) return fallback

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })

  return formatter.format(date)
}

function getMinuteOfDayFromCaptainDateTime(value?: string): number | null {
  if (!value) return null

  const match = value.match(/\b(\d{2}):(\d{2})(?::\d{2})?\b/)
  if (!match) return null

  const hour = Number(match[1])
  const minute = Number(match[2])

  if (
    Number.isNaN(hour) || Number.isNaN(minute) ||
    hour < 0 || hour > 23 ||
    minute < 0 || minute > 59
  ) {
    return null
  }

  return hour * 60 + minute
}

function getHourFromMinuteOfDay(minuteOfDay: number | null): number | null {
  if (minuteOfDay === null) return null
  return Math.floor(minuteOfDay / 60)
}

function isValidIsoDate(value: string | null): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isCompleted(row: Row): boolean {
  const status = (row.status || '').toLowerCase().trim()
  const deliveryStatus = (row.delivery_status || '').toLowerCase().trim()

  if (status === 'completed') return true
  if (deliveryStatus === 'dropped_off') return true
  if (row.delivered_at) return true

  return false
}

function getOnTimeFlag(deliveredAt?: string, promisedAt?: string): boolean | null {
  if (!deliveredAt || !promisedAt) return null

  const delivered = new Date(deliveredAt)
  const promised = new Date(promisedAt)

  if (isNaN(delivered.getTime()) || isNaN(promised.getTime())) return null

  return delivered.getTime() <= promised.getTime()
}

function getDateMinusDaysChile(days: number): string {
  const today = todayIsoInChile()
  const [year, month, day] = today.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    await getUserAccess(
      req,
      supabaseUrl,
      supabaseAnonKey,
      supabaseServiceRoleKey
    )

    const captainIntegrationKey = Deno.env.get('CAPTAIN_INTEGRATION_KEY')!
    const captainDeveloperKey = Deno.env.get('CAPTAIN_DEVELOPER_KEY')!

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)

    const url = new URL(req.url)
    const qsBusinessDate = url.searchParams.get('business_date')
    const qsDateStart = url.searchParams.get('date_start')
    const qsDateEnd = url.searchParams.get('date_end')

    let dateStart = todayIsoInChile()
    let dateEnd = dateStart

    if (isValidIsoDate(qsBusinessDate)) {
      dateStart = qsBusinessDate
      dateEnd = qsBusinessDate
    } else {
      dateStart = isValidIsoDate(qsDateStart) ? qsDateStart : dateStart
      dateEnd = isValidIsoDate(qsDateEnd) ? qsDateEnd : dateStart
    }

    if (dateStart > dateEnd) {
      return jsonResponse(
        {
          ok: false,
          error: 'date_start cannot be greater than date_end',
        },
        400
      )
    }

    const STORE_UUIDS = [
      'c52ae6896554','46fcdf13aa64','90ebe0702b23','6cd0b04f228f',
      'e4169c7cf06f','125a65d2ead2','a00d5e07a852','9412d10485df',
      '34bc0bdef595','7dda1d516d56','9bbe008e77f0','78c26568e8bd',
      'bb8bf37cdcda','e40bfa305ff2','3d632778796d','a6738d5db502',
      '36254817c5e6','9ca0d6f2611a','f81dd5e12f42','9647c98bd66e',
      '1b003fdd6209','a83d209dd3e5','b0b4ff18815b','2310a766fa1a',
      '34e74b7c2373','b7c4a2dd326d','e389651db376','3113c67b9a9f',
      '7d9e0c884c87','0c7359a69cce','0c48664fe32a','a9af394634b4',
      'ee77e63377d0','631e79d4c926','fccda11395b1','b50ea29b7dfa',
      'fb1704c9b8f1','1d2bea51c0fc','fde7888a4287','8288b9cd47aa',
      '9f59961c8c4e','1e2afe276bb8','0737a3d97256','91dd02103d29',
      '6e4e8bf843a1','38487bd8b14e','78830a96a2cf'
    ]

    const requestBody = {
      entity: 'account',
      uuids: STORE_UUIDS,
      kind: 'delivery_data',
      file_format: 'csv',
      date_start: dateStart,
      date_end: dateEnd,
      fields: [
        'order_uuid',
        'order_partners_unique_internal_order_id',
        'account_uuid',
        'status',
        'created_at',
        'collected_at',
        'delivered_at',
        'promised_delivery_time_at',
        'promised_delivery_minutes',
        'store_name',
        'delivery_status',
        'order_type'
      ],
      order_types: ['delivery']
    }

    const headers = {
      'Content-Type': 'application/json',
      'x-integration-key': captainIntegrationKey,
      'x-developer-key': captainDeveloperKey,
    }

    const createRes = await fetch('https://api.captain.ai/v1/analytics/reports', {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    })

    const createJson = await createRes.json()
    const reportUuid = createJson.uuid

    if (!reportUuid) {
      return jsonResponse({
        ok: false,
        step: 'create_report',
        response: createJson
      })
    }

    let statusJson: any = null

    for (let i = 0; i < 8; i++) {
      await sleep(3000)

      const statusRes = await fetch(`https://api.captain.ai/v1/analytics/reports/${reportUuid}`, {
        method: 'GET',
        headers,
      })

      statusJson = await statusRes.json()

      if (statusJson.status === 'completed' && statusJson.url) break
    }

    if (!statusJson?.url) {
      return jsonResponse({
        ok: false,
        step: 'timeout',
        response: statusJson
      })
    }

    const csvRes = await fetch(statusJson.url)
    const csvText = await csvRes.text()
    const csvHeaders = getCsvHeaders(csvText)
    const rows = csvToObjects(csvText)

    const grouped = new Map<string, GroupedItem>()
    const ordersMap = new Map<string, OrderRecord>()

    for (const row of rows) {
      const storeUuid = row.account_uuid?.trim()
      const orderUuid = row.order_uuid?.trim()

      if (!storeUuid || !orderUuid) continue

      const storeName = row.store_name || storeUuid
      const businessDate = toChileBusinessDate(row.created_at, dateStart)
      const groupedKey = `${businessDate}_${storeUuid}`

      if (!grouped.has(groupedKey)) {
        grouped.set(groupedKey, {
          business_date: businessDate,
          store_uuid: storeUuid,
          store_name: storeName,
          orders_total: 0,
          deliveries_total: 0,
          order_uuids: new Set<string>(),
          pick_sum: 0,
          pick_count: 0,
          delivery_sum: 0,
          delivery_count: 0,
          e2e_sum: 0,
          e2e_count: 0,
          promise_sum: 0,
          promise_count: 0,
          on_time_total: 0,
          on_time_count: 0
        })
      }

      const item = grouped.get(groupedKey)!

      if (!item.order_uuids.has(orderUuid)) {
        item.order_uuids.add(orderUuid)
        item.orders_total++
      }

      const completed = isCompleted(row)
      const pick = minutesBetween(row.created_at, row.collected_at, 0, 180)
      const delivery = minutesBetween(row.collected_at, row.delivered_at, 0, 240)
      const e2e = minutesBetween(row.created_at, row.delivered_at, 0, 300)
      const promise = parseMinutes(row.promised_delivery_minutes, 0, 300)
      const onTimeFlag = getOnTimeFlag(row.delivered_at, row.promised_delivery_time_at)
      const createdMinuteOfDay = getMinuteOfDayFromCaptainDateTime(row.created_at)
      const createdHour = getHourFromMinuteOfDay(createdMinuteOfDay)

      if (completed) {
        item.deliveries_total++
      }

      if (pick !== null) {
        item.pick_sum += pick
        item.pick_count++
      }

      if (delivery !== null) {
        item.delivery_sum += delivery
        item.delivery_count++
      }

      if (e2e !== null) {
        item.e2e_sum += e2e
        item.e2e_count++
      }

      if (promise !== null) {
        item.promise_sum += promise
        item.promise_count++
      }

      if (onTimeFlag !== null) {
        item.on_time_count++
        if (onTimeFlag) item.on_time_total++
      }

      const orderKey = `${businessDate}_${orderUuid}`

      if (!ordersMap.has(orderKey)) {
        ordersMap.set(orderKey, {
          order_uuid: orderUuid,
          order_partners_unique_internal_order_id: row.order_partners_unique_internal_order_id || null,
          business_date: businessDate,
          store_uuid: storeUuid,
          store_name: storeName,
          created_at: row.created_at || null,
          collected_at: row.collected_at || null,
          delivered_at: row.delivered_at || null,
          promised_delivery_time_at: row.promised_delivery_time_at || null,
          delivery_status: row.delivery_status || null,
          order_type: row.order_type || null,
          completed_flag: completed,
          pick_minutes: pick,
          delivery_minutes: delivery,
          e2e_minutes: e2e,
          promise_minutes: promise,
          on_time_flag: onTimeFlag,
          created_hour: createdHour,
          created_minute_of_day: createdMinuteOfDay
        })
      }
    }

    const snapshots = Array.from(grouped.values()).map(item => ({
      business_date: item.business_date,
      store_uuid: item.store_uuid,
      store_name: item.store_name,
      orders_total: item.orders_total,
      deliveries_total: item.deliveries_total,
      on_time_pct: item.on_time_count ? (item.on_time_total / item.on_time_count) * 100 : null,
      collection_minutes: item.pick_count ? item.pick_sum / item.pick_count : null,
      delivery_minutes: item.e2e_count ? item.e2e_sum / item.e2e_count : null,
      trip_minutes: item.delivery_count ? item.delivery_sum / item.delivery_count : null,
      promise_minutes: item.promise_count ? item.promise_sum / item.promise_count : null
    }))

    const orders = Array.from(ordersMap.values())
    const businessDatesFound = [...new Set(snapshots.map(s => s.business_date))]

    if (businessDatesFound.length > 0) {
      const { error: deleteSnapshotsError } = await supabase
        .from('kpi_snapshots')
        .delete()
        .in('business_date', businessDatesFound)

      if (deleteSnapshotsError) {
        return jsonResponse(
          {
            ok: false,
            step: 'delete_existing_snapshots',
            error: deleteSnapshotsError,
            business_dates_found: businessDatesFound
          },
          500
        )
      }

      const { error: deleteOrdersError } = await supabase
        .from('kpi_orders')
        .delete()
        .in('business_date', businessDatesFound)

      if (deleteOrdersError) {
        return jsonResponse(
          {
            ok: false,
            step: 'delete_existing_orders',
            error: deleteOrdersError,
            business_dates_found: businessDatesFound
          },
          500
        )
      }
    }

    if (snapshots.length > 0) {
      const { error: insertSnapshotsError } = await supabase
        .from('kpi_snapshots')
        .insert(snapshots)

      if (insertSnapshotsError) {
        return jsonResponse(
          {
            ok: false,
            step: 'insert_snapshots',
            error: insertSnapshotsError,
            rows_to_insert: snapshots.length,
            business_dates_found: businessDatesFound
          },
          500
        )
      }
    }

    if (orders.length > 0) {
      const { error: insertOrdersError } = await supabase
        .from('kpi_orders')
        .insert(orders)

      if (insertOrdersError) {
        return jsonResponse(
          {
            ok: false,
            step: 'insert_orders',
            error: insertOrdersError,
            rows_to_insert: orders.length,
            business_dates_found: businessDatesFound
          },
          500
        )
      }
    }

    const retentionLimitDate = getDateMinusDaysChile(60)

    const { error: cleanupOrdersError } = await supabase
      .from('kpi_orders')
      .delete()
      .lt('business_date', retentionLimitDate)

    if (cleanupOrdersError) {
      return jsonResponse(
        {
          ok: false,
          step: 'cleanup_old_orders',
          error: cleanupOrdersError,
          retention_limit_date: retentionLimitDate
        },
        500
      )
    }

    const { error: cleanupSnapshotsError } = await supabase
      .from('kpi_snapshots')
      .delete()
      .lt('business_date', retentionLimitDate)

    if (cleanupSnapshotsError) {
      return jsonResponse(
        {
          ok: false,
          step: 'cleanup_old_snapshots',
          error: cleanupSnapshotsError,
          retention_limit_date: retentionLimitDate
        },
        500
      )
    }

    return jsonResponse({
      ok: true,
      date_start: dateStart,
      date_end: dateEnd,
      rows_from_csv: rows.length,
      snapshots_to_insert: snapshots.length,
      orders_to_insert: orders.length,
      retention_limit_date: retentionLimitDate,
      business_dates_found: businessDatesFound,
      csv_headers: csvHeaders,
      first_row_sample: rows[0] || null
    })

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status =
      message === 'Missing bearer token' || message === 'Invalid or expired session'
        ? 401
        : message === 'Inactive user' ||
            message === 'Profile not found' ||
            message === 'Access denied: admin role required'
          ? 403
          : 500

    return jsonResponse(
      {
        ok: false,
        error: message
      },
      status
    )
  }
})
