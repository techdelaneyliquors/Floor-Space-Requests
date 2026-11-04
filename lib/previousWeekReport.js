// The Previous Week review's comparison table (Schedule page, Previous Week
// tab) rebuilt on the server, and drawn as a one-page landscape PDF for the
// Monday email. The rules mirror the page (views/Store Schedule.ejs,
// renderPrevious): change them there and here together.

const PDFDocument = require('pdfkit')

const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

// ---------- the same rules as the page ----------

// "9:00 AM" -> 9, "1:30 PM" -> 13.5
function parseTime(text) {
  const match = String(text || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (!match) return null
  let hours = Number(match[1]) % 12
  if (match[3].toUpperCase() === 'PM') hours += 12
  return hours + Number(match[2]) / 60
}

function shiftHours(shift) {
  if (!shift || !shift.includes(' to ')) return 0
  const [start, end] = shift.split(' to ').map(parseTime)
  if (start == null || end == null) return 0
  return +(end < start ? end + 24 - start : end - start).toFixed(2)
}

function normalizeShiftValues(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean)
  if (value !== undefined && value !== null && String(value).trim()) return [String(value).trim()]
  return []
}

// Scheduled hours with the 30-minute lunch taken off days of 7.5+ hours
function scheduledPaidHours(value) {
  const raw = normalizeShiftValues(value).reduce((sum, shift) => sum + shiftHours(shift), 0)
  return raw >= 7.5 ? Math.max(0, raw - 0.5) : raw
}

// Late or left early by more than 15 minutes (first shift of the day)
function attendanceIssue(scheduled, actual) {
  if (!scheduled || !actual || !scheduled.includes(' to ') || !actual.includes(' to ')) return null
  const [scheduledStart, scheduledEnd] = scheduled.split(' to ').map(parseTime)
  const [actualStart, actualEnd] = actual.split(' to ').map(parseTime)
  if ([scheduledStart, scheduledEnd, actualStart, actualEnd].some(value => value == null)) return null
  return {
    late: (actualStart - scheduledStart) * 60 > 15,
    early: (scheduledEnd - actualEnd) * 60 > 15
  }
}

// A day off whose only punch is exactly 8:00 AM to 4:00 PM
function isVacationDay(planned, actual) {
  return planned.length === 0 && actual.length === 1 &&
    /^0?8:00\s*AM\s+to\s+0?4:00\s*PM$/i.test(actual[0])
}

const normalizeName = value => {
  const name = String(value || '').trim().toLowerCase()
  return name === 'thomas' ? 'thom' : name
}

// "Jane Q Doe" -> "Jane D."
function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/)
  return parts.length <= 1 ? (parts[0] || '') : `${parts[0]} ${parts[parts.length - 1][0]}.`
}

const addDays = (ymd, days) => {
  const date = new Date(`${ymd}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const mondayOf = ymd => {
  const day = new Date(`${ymd}T12:00:00Z`).getUTCDay()
  return addDays(ymd, -((day + 6) % 7))
}

/*
 * input: {
 *   settings: the store's ScheduleSettings (lean),
 *   hasCashiers, sickDays: [{ employeeNumber, date, type, hours }],
 *   salariedNumbers: Set, hoursBudget: { defaultHours, overrides }
 * }
 * Returns the table (or { weekStart: '' } when no week is uploaded).
 */
function buildPreviousWeekReport(input) {
  const settings = input.settings || {}
  const start = settings.previousWeekStart ? new Date(settings.previousWeekStart) : null
  if (!start || Number.isNaN(start.getTime())) return { weekStart: '' }

  const weekStart = mondayOf(start.toISOString().slice(0, 10))
  let end = settings.previousWeekEnd ? new Date(settings.previousWeekEnd) : null
  if (!end || Number.isNaN(end.getTime())) {
    end = new Date(start)
    end.setUTCDate(end.getUTCDate() + 6)
  }

  const buildIds = settings.buildEmployeeIdentifiers || {}
  const uploadedIds = settings.employeeIdentifiers || {}
  const scheduledShiftsByName = settings.previousScheduledShifts || {}
  const actualShiftsByName = settings.previousActualShifts || {}
  const actualHoursByName = settings.previousActualHours || {}
  const scheduledHoursByName = settings.previousScheduledHours || {}

  const sickDayFor = (number, date) =>
    (input.sickDays || []).find(entry => entry.employeeNumber === number && entry.date === date) || null
  const paidSickHours = (number, date) => {
    const sick = sickDayFor(number, date)
    return sick && sick.type === 'paid-sick' ? Number(sick.hours || 0) : 0
  }
  const isSalaried = number => Boolean(number) && input.salariedNumbers.has(String(number))
  const paidOvertimeFor = (number, hours) => isSalaried(number) ? 0 : Math.max(0, Number(hours || 0) - 40)

  // Everyone on the Build tab, matched to the upload by name and number
  const names = [...new Set([
    ...(settings.managers || []),
    ...(settings.associates || []),
    ...(input.hasCashiers ? (settings.cashiers || []) : [])
  ])]

  const matched = names.map(buildName => {
    const id = String(buildIds[buildName] || '').trim()
    if (!id) return null
    const uploadedName = Object.keys(uploadedIds).find(name =>
      normalizeName(name) === normalizeName(buildName) && String(uploadedIds[name] || '').trim() === id)
    if (!uploadedName) return null
    const hasData = Boolean(scheduledShiftsByName[uploadedName]) || Boolean(actualShiftsByName[uploadedName]) ||
      Boolean(actualHoursByName[uploadedName]) || scheduledHoursByName[uploadedName] !== undefined
    return hasData ? { buildName, uploadedName, id } : null
  }).filter(Boolean)

  const dayTotals = DAY_KEYS.map(() => ({ scheduled: 0, actual: 0 }))
  const totals = { scheduled: 0, worked: 0, plannedOvertime: 0, paidOvertime: 0 }

  const rows = matched.map(({ buildName, uploadedName, id }) => {
    const scheduledShifts = scheduledShiftsByName[uploadedName] || {}
    const actualShifts = actualShiftsByName[uploadedName] || {}
    const actualHours = actualHoursByName[uploadedName] || {}
    const scheduledTotal = Number(scheduledHoursByName[uploadedName] || 0)

    const clockedTotal = DAY_KEYS.reduce((sum, day) => sum + Number(actualHours[day] || 0), 0)
    const paidSickTotal = DAY_KEYS.reduce((sum, day, index) => sum + paidSickHours(id, addDays(weekStart, index)), 0)
    const workedTotal = clockedTotal + paidSickTotal
    const vacationTotal = DAY_KEYS.reduce((sum, day) =>
      sum + (isVacationDay(normalizeShiftValues(scheduledShifts[day]), normalizeShiftValues(actualShifts[day]))
        ? Number(actualHours[day] || 0) : 0), 0)
    const overtimeBasis = clockedTotal - vacationTotal

    const salaried = isSalaried(id)
    const plannedOvertime = salaried ? 0 : Math.max(0, scheduledTotal - 40)
    const paidOvertime = paidOvertimeFor(id, overtimeBasis)

    totals.scheduled += scheduledTotal
    totals.worked += workedTotal
    totals.plannedOvertime += plannedOvertime
    totals.paidOvertime += paidOvertime

    const days = DAY_KEYS.map((day, index) => {
      const date = addDays(weekStart, index)
      const planned = normalizeShiftValues(scheduledShifts[day])
      const actual = normalizeShiftValues(actualShifts[day])
      const scheduledDayHours = scheduledPaidHours(planned)
      const actualDayHours = Number(actualHours[day] || 0)

      dayTotals[index].scheduled += scheduledDayHours
      dayTotals[index].actual += actualDayHours + paidSickHours(id, date)

      const issue = planned.length && actual.length ? attendanceIssue(planned[0], actual[0]) : null
      const sick = sickDayFor(id, date)

      let kind = ''
      if (planned.length && !actual.length) kind = 'no-time'
      else if (isVacationDay(planned, actual)) kind = 'vacation'
      else if (!planned.length && actual.length) kind = 'unscheduled'
      else if (issue && issue.late && issue.early) kind = 'severe'
      else if (issue && (issue.late || issue.early)) kind = 'issue'

      return {
        empty: !planned.length && !actual.length,
        planned: planned.length ? planned.map(value => value.replace(' to ', ' - ')) : ['OFF'],
        actual: actual.length ? actual.map(value => value.replace(' to ', ' - ')) : ['No time worked'],
        kind,
        dailyOvertime: scheduledDayHours > 0 && actualDayHours >= scheduledDayHours + 0.5,
        marker: kind === 'vacation'
          ? 'Vacation'
          : sick
            ? (sick.type === 'paid-sick' ? `Paid sick ${Number(sick.hours).toFixed(2)}` : 'Unpaid sick')
            : ''
      }
    })

    return {
      name: shortName(buildName),
      days,
      scheduledTotal,
      workedTotal,
      difference: workedTotal - scheduledTotal,
      salaried,
      plannedOvertime,
      paidOvertime,
      paidOverPlanned: !salaried && paidOvertime - plannedOvertime > 0.005
    }
  })

  const budget = input.hoursBudget || {}
  const override = (budget.overrides || []).find(entry => entry.weekStart === weekStart)
  const budgetHours = override ? override.hours : (typeof budget.defaultHours === 'number' ? budget.defaultHours : null)

  const format = (date, withYear) => date.toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {})
  })

  return {
    weekStart,
    weekLabel: `Week of ${format(start, start.getUTCFullYear() !== end.getUTCFullYear())} – ${format(end, true)}`,
    rows,
    dayTotals,
    totals: {
      ...totals,
      difference: totals.worked - totals.scheduled,
      paidOverPlanned: totals.paidOvertime - totals.plannedOvertime > 0.005,
      budgetHours
    }
  }
}

// ---------- the PDF ----------

const COLORS = {
  ink: '#172033',
  muted: '#64748b',
  headerFill: '#e9f0fa',
  headerInk: '#17365d',
  line: '#cbd5e1',
  totalFill: '#d9e1f2',
  totalLine: '#4a6fa5',
  cell: {
    'no-time': '#fca5a5',
    vacation: '#e0f2fe',
    unscheduled: '#fde68a',
    severe: '#ef5a5a',
    issue: '#f7a7a7',
    overtime: '#dcfce7'
  },
  actual: {
    'no-time': '#991b1b',
    unscheduled: '#92400e',
    overtime: '#166534'
  },
  marker: { vacation: '#0369a1', sick: '#1d4ed8' },
  green: '#15803d',
  red: '#b91c1c',
  overFill: '#fee2e2',
  overInk: '#991b1b',
  withinFill: '#dcfce7'
}

// A Buffer holding the PDF: "<store>: Week of …: Previous Week Comparison"
// and the table, scaled to fit one landscape page
function renderPreviousWeekPdf(store, report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 24 })
    const chunks = []
    doc.on('data', chunk => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const left = 24
    const top = 24
    const width = doc.page.width - 48
    const bottom = doc.page.height - 24

    doc.font('Helvetica-Bold').fontSize(13).fillColor('#1e3a8a')
      .text(`${store}: ${report.weekLabel}: Previous Week Comparison`, left, top, { width })

    // Employee, 7 days, Sched., Worked, Diff., Planned OT, Paid OT
    const fixed = [78, 42, 50, 40, 44, 44]
    const dayWidth = (width - fixed.reduce((a, b) => a + b, 0)) / 7
    const widths = [fixed[0], ...Array(7).fill(dayWidth), ...fixed.slice(1)]
    const xs = widths.reduce((list, w, i) => { list.push(i ? list[i - 1] + widths[i - 1] : left); return list }, [])

    const tableTop = top + 24
    const headerHeight = 16

    // Scale the text so every row fits on the one page
    const linesFor = day => day.empty ? 1 : day.planned.length + day.actual.length + (day.marker ? 1 : 0)
    const rowLines = report.rows.map(row => Math.max(1, ...row.days.map(linesFor)))
    const totalLines = rowLines.reduce((a, b) => a + b, 0) + 2 // + total row
    const room = bottom - tableTop - headerHeight - 6 * (report.rows.length + 1)
    const fontSize = Math.max(4.5, Math.min(7.5, room / totalLines / 1.2))
    const lineHeight = fontSize * 1.2

    // Centered on one line; text too wide for the cell is shrunk to fit
    // rather than wrapped
    const center = (text, x, y, w) => {
      const size = doc._fontSize
      const room = w - 4
      let textWidth = doc.widthOfString(text)
      if (textWidth > room) {
        doc.fontSize(size * room / textWidth)
        textWidth = doc.widthOfString(text)
      }
      doc.text(text, x + (w - textWidth) / 2, y, { lineBreak: false })
      doc.fontSize(size)
    }

    // Header row
    doc.rect(left, tableTop, width, headerHeight).fill(COLORS.headerFill)
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(COLORS.headerInk)
    const headers = ['EMPLOYEE', ...DAY_LABELS.map(day => day.toUpperCase()), 'SCHED.', 'WORKED', 'DIFF.', 'PLANNED OT', 'PAID OT']
    headers.forEach((text, i) => {
      if (i === 0) doc.text(text, xs[i] + 3, tableTop + 5, { width: widths[i] - 6, lineBreak: false })
      else center(text, xs[i], tableTop + 5, widths[i])
    })

    let y = tableTop + headerHeight

    const hours = value => value.toFixed(2)
    const differenceColor = value => value < 0 ? COLORS.red : value > 0 ? COLORS.green : COLORS.ink

    report.rows.forEach((row, rowIndex) => {
      const height = rowLines[rowIndex] * lineHeight + 6
      const mid = y + (height - fontSize) / 2

      // Day cells
      row.days.forEach((day, i) => {
        const x = xs[i + 1]
        const w = widths[i + 1]
        const fill = COLORS.cell[day.kind] || (day.dailyOvertime ? COLORS.cell.overtime : null)
        if (fill) doc.rect(x, y, w, height).fill(fill)
        // Daily overtime on top of another color: a green bar along the bottom
        if (day.dailyOvertime && COLORS.cell[day.kind]) doc.rect(x, y + height - 2.5, w, 2.5).fill('#16a34a')
        if (day.empty) return

        let lineY = y + 3
        doc.font('Helvetica').fontSize(fontSize).fillColor(COLORS.ink)
        day.planned.forEach(text => { center(text, x, lineY, w); lineY += lineHeight })

        const actualColor = COLORS.actual[day.kind] || (day.dailyOvertime ? COLORS.actual.overtime : COLORS.muted)
        const bold = Boolean(COLORS.actual[day.kind] || day.dailyOvertime)
        doc.font(bold ? 'Helvetica-BoldOblique' : 'Helvetica-Oblique').fillColor(actualColor)
        day.actual.forEach(text => { center(text, x, lineY, w); lineY += lineHeight })

        if (day.marker) {
          doc.font('Helvetica-Bold').fillColor(day.kind === 'vacation' ? COLORS.marker.vacation : COLORS.marker.sick)
          center(day.marker, x, lineY, w)
        }
      })

      // Name and totals
      doc.font('Helvetica-Bold').fontSize(fontSize + 0.5).fillColor(COLORS.ink)
        .text(row.name, xs[0] + 3, mid, { width: widths[0] - 6, lineBreak: false })

      doc.font('Helvetica').fontSize(fontSize + 0.5)
      center(hours(row.scheduledTotal), xs[8], mid, widths[8])
      center(hours(row.workedTotal), xs[9], mid, widths[9])
      doc.fillColor(differenceColor(row.difference))
      center(hours(row.difference), xs[10], mid, widths[10])
      doc.fillColor(COLORS.ink)
      center(row.salaried ? '—' : hours(row.plannedOvertime), xs[11], mid, widths[11])

      if (row.salaried) {
        doc.font('Helvetica-Oblique').fillColor(COLORS.muted)
        center('Salaried', xs[12], mid, widths[12])
      } else {
        if (row.paidOverPlanned) doc.rect(xs[12], y, widths[12], height).fill(COLORS.overFill)
        doc.font(row.paidOverPlanned ? 'Helvetica-Bold' : 'Helvetica')
          .fillColor(row.paidOverPlanned ? COLORS.overInk : COLORS.ink)
        center(hours(row.paidOvertime), xs[12], mid, widths[12])
      }

      doc.moveTo(left, y + height).lineTo(left + width, y + height).lineWidth(0.5).strokeColor(COLORS.line).stroke()
      y += height
    })

    // Total row: S/A per day, totals, worked over the hours budget
    const totalHeight = lineHeight * 2 + 8
    doc.rect(left, y, width, totalHeight).fill(COLORS.totalFill)
    doc.moveTo(left, y).lineTo(left + width, y).lineWidth(1.5).strokeColor(COLORS.totalLine).stroke()
    const totalMid = y + (totalHeight - fontSize) / 2

    doc.font('Helvetica-Bold').fontSize(fontSize + 0.5).fillColor(COLORS.ink)
      .text('TOTAL', xs[0] + 3, totalMid, { width: widths[0] - 6, lineBreak: false })

    report.dayTotals.forEach((day, i) => {
      doc.font('Helvetica-Bold').fontSize(fontSize).fillColor(COLORS.ink)
      center(`S: ${hours(day.scheduled)}`, xs[i + 1], y + 4, widths[i + 1])
      doc.font('Helvetica-Oblique').fillColor(COLORS.muted)
      center(`A: ${hours(day.actual)}`, xs[i + 1], y + 4 + lineHeight, widths[i + 1])
    })

    const t = report.totals
    doc.font('Helvetica-Bold').fontSize(fontSize + 0.5).fillColor(COLORS.ink)
    center(hours(t.scheduled), xs[8], totalMid, widths[8])

    // Worked over the budget as a fraction, green within / red over
    if (t.budgetHours !== null && t.budgetHours !== undefined) {
      const over = t.worked - t.budgetHours > 0.005
      doc.rect(xs[9], y, widths[9], totalHeight).fill(over ? COLORS.overFill : COLORS.withinFill)
      const ink = over ? COLORS.overInk : COLORS.ink
      doc.font('Helvetica-Bold').fontSize(fontSize + 0.5).fillColor(ink)
      center(hours(t.worked), xs[9], y + 3, widths[9])
      const lineY = y + 3 + lineHeight + 0.5
      doc.moveTo(xs[9] + 8, lineY).lineTo(xs[9] + widths[9] - 8, lineY).lineWidth(1).strokeColor(ink).stroke()
      center(hours(t.budgetHours), xs[9], lineY + 2, widths[9])
    } else {
      center(hours(t.worked), xs[9], totalMid, widths[9])
    }

    doc.font('Helvetica-Bold').fillColor(differenceColor(t.difference))
    center(hours(t.difference), xs[10], totalMid, widths[10])
    doc.fillColor(COLORS.ink)
    center(hours(t.plannedOvertime), xs[11], totalMid, widths[11])
    if (t.paidOverPlanned) doc.rect(xs[12], y, widths[12], totalHeight).fill(COLORS.overFill)
    doc.font('Helvetica-Bold').fillColor(t.paidOverPlanned ? COLORS.overInk : COLORS.ink)
    center(hours(t.paidOvertime), xs[12], totalMid, widths[12])

    y += totalHeight

    // Column lines and the outer border
    doc.lineWidth(0.5).strokeColor(COLORS.line)
    xs.slice(1).forEach(x => doc.moveTo(x, tableTop).lineTo(x, y).stroke())
    doc.rect(left, tableTop, width, y - tableTop).stroke()

    if (!report.rows.length) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(COLORS.muted)
        .text('No employees on the schedule matched the uploaded week.', left, y + 10, { width })
    }

    doc.end()
  })
}

module.exports = { buildPreviousWeekReport, renderPreviousWeekPdf, mondayOf, addDays }
