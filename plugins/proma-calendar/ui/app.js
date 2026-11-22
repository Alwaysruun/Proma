(function () {
  'use strict'

  var api = window.proma.planning
  var state = {
    cursor: startOfMonth(new Date()),
    view: 'month',
    events: [],
    groups: [],
    selected: null,
    loading: true,
    error: ''
  }

  var els = {
    subtitle: document.getElementById('subtitle'),
    monthView: document.getElementById('month-view'),
    agendaView: document.getElementById('agenda-view'),
    grid: document.getElementById('grid'),
    agenda: document.getElementById('agenda'),
    agendaEmpty: document.getElementById('agenda-empty'),
    prev: document.getElementById('prev'),
    next: document.getElementById('next'),
    today: document.getElementById('today'),
    add: document.getElementById('add'),
    backdrop: document.getElementById('editor-backdrop'),
    editor: document.getElementById('editor'),
    mode: document.getElementById('editor-mode'),
    close: document.getElementById('editor-close'),
    title: document.getElementById('event-title'),
    allDay: document.getElementById('event-allday'),
    start: document.getElementById('event-start'),
    end: document.getElementById('event-end'),
    group: document.getElementById('event-group'),
    notes: document.getElementById('event-notes'),
    save: document.getElementById('event-save'),
    remove: document.getElementById('event-delete')
  }

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = text
    return node
  }

  function startOfDay(date) {
    var next = new Date(date)
    next.setHours(0, 0, 0, 0)
    return next
  }

  function addDays(date, days) {
    var next = new Date(date)
    next.setDate(next.getDate() + days)
    return next
  }

  function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1)
  }

  function addMonths(date, months) {
    return new Date(date.getFullYear(), date.getMonth() + months, 1)
  }

  function startOfWeek(date) {
    var day = (date.getDay() + 6) % 7
    return addDays(startOfDay(date), -day)
  }

  function dateKey(date) {
    var month = String(date.getMonth() + 1).padStart(2, '0')
    var day = String(date.getDate()).padStart(2, '0')
    return date.getFullYear() + '-' + month + '-' + day
  }

  function toLocalInput(timestamp) {
    if (!timestamp) return ''
    var date = new Date(timestamp)
    var local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    return local.toISOString().slice(0, 16)
  }

  function fromLocalInput(value) {
    if (!value) return null
    var timestamp = new Date(value).getTime()
    return Number.isFinite(timestamp) ? timestamp : null
  }

  function monthLabel(date) {
    return date.getFullYear() + '年' + (date.getMonth() + 1) + '月'
  }

  function eventTime(event) {
    if (event.allDay) return '全天'
    var start = new Date(event.startAt)
    var text = String(start.getHours()).padStart(2, '0') + ':' + String(start.getMinutes()).padStart(2, '0')
    if (event.endAt) {
      var end = new Date(event.endAt)
      if (dateKey(start) === dateKey(end)) {
        text += '–' + String(end.getHours()).padStart(2, '0') + ':' + String(end.getMinutes()).padStart(2, '0')
      }
    }
    return text
  }

  function groupName(groupId) {
    for (var i = 0; i < state.groups.length; i++) {
      if (state.groups[i].id === groupId) return state.groups[i].name
    }
    return ''
  }

  function groupEvents() {
    var map = {}
    state.events.forEach(function (event) {
      var key = dateKey(new Date(event.startAt))
      if (!map[key]) map[key] = []
      map[key].push(event)
    })
    Object.keys(map).forEach(function (key) {
      map[key].sort(function (a, b) {
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
        return a.startAt - b.startAt
      })
    })
    return map
  }

  function renderSubtitle() {
    if (state.loading) { els.subtitle.textContent = '加载中…'; return }
    if (state.error) { els.subtitle.textContent = state.error; return }
    var monthStart = startOfMonth(state.cursor).getTime()
    var monthEnd = addMonths(state.cursor, 1).getTime()
    var count = state.events.filter(function (event) {
      return event.startAt >= monthStart && event.startAt < monthEnd
    }).length
    els.subtitle.textContent = monthLabel(state.cursor) + ' · ' + count + ' 个日程'
  }

  function renderViewTabs() {
    var tabs = document.querySelectorAll('.view-tab')
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('is-active', tabs[i].getAttribute('data-view') === state.view)
    }
    els.monthView.hidden = state.view !== 'month'
    els.agendaView.hidden = state.view !== 'agenda'
  }

  function renderMonth() {
    els.grid.textContent = ''
    var byDay = groupEvents()
    var first = startOfMonth(state.cursor)
    var gridStart = startOfWeek(first)
    var todayKey = dateKey(new Date())

    for (var i = 0; i < 42; i++) {
      var date = addDays(gridStart, i)
      var key = dateKey(date)
      var outside = date.getMonth() !== state.cursor.getMonth()
      var cell = el('div', 'day' + (outside ? ' is-outside' : '') + (key === todayKey ? ' is-today' : ''))
      cell.setAttribute('data-date', key)
      cell.appendChild(el('div', 'day-number', String(date.getDate())))
      cell.addEventListener('click', function () {
        var clicked = this.getAttribute('data-date')
        var parts = clicked.split('-')
        openEditor(null, new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])))
      })

      var dayEvents = byDay[key] || []
      dayEvents.slice(0, 3).forEach(function (event) {
        var chip = el('div', 'event-chip' + (event.allDay ? ' is-allday' : ''), (event.allDay ? '' : eventTime(event) + ' ') + event.title)
        chip.title = event.title
        chip.addEventListener('click', function (clickEvent) {
          clickEvent.stopPropagation()
          openEditor(event, null)
        })
        cell.appendChild(chip)
      })
      if (dayEvents.length > 3) {
        cell.appendChild(el('div', 'more', '+' + (dayEvents.length - 3) + ' 更多'))
      }
      els.grid.appendChild(cell)
    }
  }

  function renderAgenda() {
    els.agenda.textContent = ''
    var monthStart = startOfMonth(state.cursor).getTime()
    var monthEnd = addMonths(state.cursor, 1).getTime()
    var events = state.events.filter(function (event) {
      return event.startAt >= monthStart && event.startAt < monthEnd
    }).sort(function (a, b) { return a.startAt - b.startAt })
    els.agendaEmpty.hidden = events.length > 0
    if (events.length === 0) return

    var groups = {}
    events.forEach(function (event) {
      var key = dateKey(new Date(event.startAt))
      if (!groups[key]) groups[key] = []
      groups[key].push(event)
    })
    Object.keys(groups).sort().forEach(function (key) {
      var group = el('div', 'agenda-group')
      var date = new Date(key + 'T00:00:00')
      group.appendChild(el('div', 'agenda-date', date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })))
      groups[key].forEach(function (event) {
        var row = el('button', 'agenda-event')
        row.type = 'button'
        row.appendChild(el('span', 'agenda-time', eventTime(event)))
        row.appendChild(el('span', 'agenda-title', event.title))
        var name = groupName(event.groupId)
        if (name) row.appendChild(el('span', 'agenda-group-name', name))
        row.addEventListener('click', function () { openEditor(event, null) })
        group.appendChild(row)
      })
      els.agenda.appendChild(group)
    })
  }

  function render() {
    renderSubtitle()
    renderViewTabs()
    renderMonth()
    renderAgenda()
  }

  function renderGroupOptions() {
    els.group.textContent = ''
    var none = el('option', '', '不分组')
    none.value = ''
    els.group.appendChild(none)
    state.groups.forEach(function (group) {
      var option = el('option', '', group.name)
      option.value = group.id
      els.group.appendChild(option)
    })
  }

  function openEditor(event, date) {
    state.selected = event || null
    els.mode.textContent = event ? '编辑日程' : '新建日程'
    els.remove.hidden = !event
    renderGroupOptions()

    if (event) {
      els.title.value = event.title
      els.allDay.checked = Boolean(event.allDay)
      els.start.value = toLocalInput(event.startAt)
      els.end.value = toLocalInput(event.endAt)
      els.group.value = event.groupId || ''
      els.notes.value = event.notes || ''
    } else {
      var start = date ? new Date(date) : new Date()
      start.setHours(9, 0, 0, 0)
      var end = new Date(start.getTime() + 3600000)
      els.title.value = ''
      els.allDay.checked = false
      els.start.value = toLocalInput(start.getTime())
      els.end.value = toLocalInput(end.getTime())
      els.group.value = ''
      els.notes.value = ''
    }
    els.editor.hidden = false
    els.backdrop.hidden = false
    els.title.focus()
  }

  function closeEditor() {
    els.editor.hidden = true
    els.backdrop.hidden = true
    state.selected = null
  }

  async function load() {
    state.loading = true
    renderSubtitle()
    try {
      var first = startOfMonth(state.cursor)
      var rangeStart = startOfWeek(first)
      var rangeEnd = addDays(rangeStart, 42)
      var results = await Promise.all([
        api.listCalendarEvents({ from: rangeStart.getTime(), to: rangeEnd.getTime() }),
        api.listGroups('calendar')
      ])
      state.events = results[0] || []
      state.groups = results[1] || []
      state.error = ''
    } catch (error) {
      state.error = '加载失败：' + (error && error.message ? error.message : String(error))
    } finally {
      state.loading = false
      render()
    }
  }

  async function saveEvent() {
    var title = els.title.value.trim()
    if (!title) { state.error = '日程标题不能为空'; renderSubtitle(); return }
    var startAt = fromLocalInput(els.start.value)
    if (startAt === null) { state.error = '请选择开始时间'; renderSubtitle(); return }
    var allDay = els.allDay.checked
    var endAt = fromLocalInput(els.end.value)
    if (allDay) {
      var day = startOfDay(new Date(startAt))
      startAt = day.getTime()
      endAt = addDays(day, 1).getTime() - 1
    }
    if (endAt !== null && endAt < startAt) { state.error = '结束时间不能早于开始时间'; renderSubtitle(); return }
    var groupId = els.group.value || null

    try {
      if (state.selected) {
        await api.updateCalendarEvent({
          id: state.selected.id,
          title: title,
          notes: els.notes.value,
          startAt: startAt,
          endAt: endAt,
          allDay: allDay,
          groupId: groupId,
          expectedUpdatedAt: state.selected.updatedAt
        })
      } else {
        await api.createCalendarEvent({
          title: title,
          notes: els.notes.value,
          startAt: startAt,
          endAt: endAt === null ? undefined : endAt,
          allDay: allDay,
          groupId: groupId === null ? undefined : groupId
        })
      }
      state.error = ''
      closeEditor()
      await load()
    } catch (error) {
      state.error = '保存失败：' + (error && error.message ? error.message : String(error))
      renderSubtitle()
    }
  }

  async function removeEvent() {
    if (!state.selected) return
    if (!window.confirm('删除日程「' + state.selected.title + '」？')) return
    try {
      await api.deleteCalendarEvent(state.selected.id)
      closeEditor()
      await load()
    } catch (error) {
      state.error = '删除失败：' + (error && error.message ? error.message : String(error))
      renderSubtitle()
    }
  }

  document.querySelectorAll('.view-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      state.view = this.getAttribute('data-view')
      render()
    })
  })

  els.prev.addEventListener('click', function () {
    state.cursor = addMonths(state.cursor, -1)
    load()
  })
  els.next.addEventListener('click', function () {
    state.cursor = addMonths(state.cursor, 1)
    load()
  })
  els.today.addEventListener('click', function () {
    state.cursor = startOfMonth(new Date())
    load()
  })
  els.add.addEventListener('click', function () { openEditor(null, new Date()) })
  els.close.addEventListener('click', closeEditor)
  els.backdrop.addEventListener('click', closeEditor)
  els.save.addEventListener('click', saveEvent)
  els.remove.addEventListener('click', removeEvent)
  els.allDay.addEventListener('change', function () {
    if (!els.allDay.checked) return
    var start = fromLocalInput(els.start.value)
    if (start !== null) {
      var day = startOfDay(new Date(start))
      els.start.value = toLocalInput(day.getTime())
      els.end.value = toLocalInput(addDays(day, 1).getTime() - 60000)
    }
  })

  window.proma.on('planning:changed', function (change) {
    var resources = change && change.resources ? change.resources : []
    if (resources.length === 0 || resources.indexOf('calendar_events') >= 0 || resources.indexOf('calendar_groups') >= 0 || resources.indexOf('reminders') >= 0) {
      load()
    }
  })

  window.proma.ready.then(load)
})()
