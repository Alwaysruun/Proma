(function () {
  'use strict'

  var api = window.proma.planning
  var state = { todos: [], groups: [], filter: 'open', selectedId: null, loading: true, error: '' }
  var lastDetailKey = ''

  var els = {
    subtitle: document.getElementById('subtitle'),
    list: document.getElementById('list'),
    empty: document.getElementById('empty'),
    detail: document.getElementById('detail'),
    detailTitle: document.getElementById('detail-title'),
    detailNotes: document.getElementById('detail-notes'),
    detailPriority: document.getElementById('detail-priority'),
    detailGroup: document.getElementById('detail-group'),
    detailDue: document.getElementById('detail-due'),
    detailMeta: document.getElementById('detail-meta'),
    detailSave: document.getElementById('detail-save'),
    detailToggle: document.getElementById('detail-toggle'),
    detailDelete: document.getElementById('detail-delete'),
    detailClose: document.getElementById('detail-close'),
    createForm: document.getElementById('create-form'),
    newTitle: document.getElementById('new-title'),
    newPriority: document.getElementById('new-priority'),
    newDue: document.getElementById('new-due')
  }

  var PRIORITY_LABEL = { high: '高优先级', medium: '中优先级', low: '低优先级' }

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = text
    return node
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

  function formatDue(timestamp) {
    if (!timestamp) return ''
    return new Date(timestamp).toLocaleString('zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
    })
  }

  function groupName(groupId) {
    for (var i = 0; i < state.groups.length; i++) {
      if (state.groups[i].id === groupId) return state.groups[i].name
    }
    return ''
  }

  function selectedTodo() {
    for (var i = 0; i < state.todos.length; i++) {
      if (state.todos[i].id === state.selectedId) return state.todos[i]
    }
    return null
  }

  function visibleTodos() {
    var list = state.todos.filter(function (todo) {
      if (state.filter === 'all') return true
      return todo.status === state.filter
    })
    list.sort(function (a, b) {
      if (a.status !== b.status) return a.status === 'open' ? -1 : 1
      var aDue = a.dueAt || Number.MAX_SAFE_INTEGER
      var bDue = b.dueAt || Number.MAX_SAFE_INTEGER
      if (aDue !== bDue) return aDue - bDue
      return b.updatedAt - a.updatedAt
    })
    return list
  }

  function renderSubtitle() {
    if (state.loading) { els.subtitle.textContent = '加载中…'; return }
    if (state.error) { els.subtitle.textContent = state.error; return }
    var open = state.todos.filter(function (todo) { return todo.status === 'open' }).length
    els.subtitle.textContent = open + ' 个进行中 · ' + state.todos.length + ' 个任务'
  }

  function renderFilters() {
    var buttons = document.querySelectorAll('.filter')
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('is-active', buttons[i].getAttribute('data-filter') === state.filter)
    }
  }

  function renderList() {
    els.list.textContent = ''
    var todos = visibleTodos()
    if (todos.length === 0) { els.empty.hidden = false; return }
    els.empty.hidden = true

    todos.forEach(function (todo) {
      var row = el('div', 'todo-row' + (todo.status === 'completed' ? ' is-done' : '') + (todo.id === state.selectedId ? ' is-selected' : ''))
      row.addEventListener('click', function () { selectTodo(todo.id) })

      var check = el('button', 'check', todo.status === 'completed' ? '✓' : '')
      check.type = 'button'
      check.setAttribute('aria-label', todo.status === 'completed' ? '恢复任务' : '完成任务')
      check.addEventListener('click', function (event) { event.stopPropagation(); toggleTodo(todo) })
      row.appendChild(check)

      var main = el('div', 'todo-main')
      main.appendChild(el('div', 'todo-title', todo.title))
      var meta = el('div', 'todo-meta')
      if (todo.dueAt) {
        meta.appendChild(el('span', todo.status === 'open' && todo.dueAt < Date.now() ? 'overdue' : '', formatDue(todo.dueAt)))
      }
      if (todo.priority && todo.priority !== 'low') {
        meta.appendChild(el('span', 'chip priority-' + todo.priority, PRIORITY_LABEL[todo.priority]))
      }
      var group = groupName(todo.groupId)
      if (group) meta.appendChild(el('span', 'chip', group))
      if (meta.childNodes.length > 0) main.appendChild(meta)
      row.appendChild(main)

      var remove = el('button', 'icon-button', '×')
      remove.type = 'button'
      remove.setAttribute('aria-label', '删除任务')
      remove.addEventListener('click', function (event) { event.stopPropagation(); removeTodo(todo) })
      row.appendChild(remove)

      els.list.appendChild(row)
    })
  }

  function renderGroupOptions() {
    els.detailGroup.textContent = ''
    var none = el('option', '', '不分组')
    none.value = ''
    els.detailGroup.appendChild(none)
    state.groups.forEach(function (group) {
      var option = el('option', '', group.name)
      option.value = group.id
      els.detailGroup.appendChild(option)
    })
  }

  function renderDetail() {
    var todo = selectedTodo()
    els.detail.hidden = !todo
    if (!todo) { lastDetailKey = ''; return }
    var key = todo.id + ':' + todo.updatedAt
    if (key === lastDetailKey) return
    lastDetailKey = key
    els.detailTitle.value = todo.title
    els.detailNotes.value = todo.notes || ''
    els.detailPriority.value = todo.priority || 'medium'
    els.detailDue.value = toLocalInput(todo.dueAt)
    renderGroupOptions()
    els.detailGroup.value = todo.groupId || ''
    els.detailToggle.textContent = todo.status === 'completed' ? '恢复任务' : '标记完成'
    var pieces = []
    if (todo.createdAt) pieces.push('创建于 ' + new Date(todo.createdAt).toLocaleString('zh-CN'))
    if (todo.completedAt) pieces.push('完成于 ' + new Date(todo.completedAt).toLocaleString('zh-CN'))
    els.detailMeta.textContent = pieces.join(' · ')
  }

  function render() {
    renderSubtitle()
    renderFilters()
    renderList()
    renderDetail()
  }

  function selectTodo(id) {
    state.selectedId = state.selectedId === id ? null : id
    lastDetailKey = ''
    render()
  }

  async function load() {
    state.loading = true
    renderSubtitle()
    try {
      var results = await Promise.all([api.listTodos(), api.listGroups('todo')])
      state.todos = results[0] || []
      state.groups = results[1] || []
      state.error = ''
      if (state.selectedId && !selectedTodo()) state.selectedId = null
    } catch (error) {
      state.error = '加载失败：' + (error && error.message ? error.message : String(error))
    } finally {
      state.loading = false
      lastDetailKey = ''
      render()
    }
  }

  async function createTodo(event) {
    event.preventDefault()
    var title = els.newTitle.value.trim()
    if (!title) return
    try {
      var dueAt = fromLocalInput(els.newDue.value)
      await api.createTodo({
        title: title,
        priority: els.newPriority.value,
        dueAt: dueAt === null ? undefined : dueAt
      })
      els.newTitle.value = ''
      els.newDue.value = ''
      els.newTitle.focus()
      await load()
    } catch (error) {
      state.error = '创建失败：' + (error && error.message ? error.message : String(error))
      renderSubtitle()
    }
  }

  async function toggleTodo(todo) {
    try {
      await api.updateTodo({
        id: todo.id,
        status: todo.status === 'completed' ? 'open' : 'completed',
        expectedUpdatedAt: todo.updatedAt
      })
      await load()
    } catch (error) {
      state.error = '更新失败：' + (error && error.message ? error.message : String(error))
      renderSubtitle()
    }
  }

  async function saveDetail() {
    var todo = selectedTodo()
    if (!todo) return
    var title = els.detailTitle.value.trim()
    if (!title) { state.error = '标题不能为空'; renderSubtitle(); return }
    try {
      var dueAt = fromLocalInput(els.detailDue.value)
      var groupId = els.detailGroup.value || null
      await api.updateTodo({
        id: todo.id,
        title: title,
        notes: els.detailNotes.value,
        priority: els.detailPriority.value,
        dueAt: dueAt,
        groupId: groupId,
        expectedUpdatedAt: todo.updatedAt
      })
      state.error = ''
      await load()
    } catch (error) {
      state.error = '保存失败：' + (error && error.message ? error.message : String(error))
      renderSubtitle()
    }
  }

  async function removeTodo(todo) {
    if (!window.confirm('删除任务「' + todo.title + '」？')) return
    try {
      await api.deleteTodo(todo.id)
      if (state.selectedId === todo.id) state.selectedId = null
      await load()
    } catch (error) {
      state.error = '删除失败：' + (error && error.message ? error.message : String(error))
      renderSubtitle()
    }
  }

  var filterButtons = document.querySelectorAll('.filter')
  for (var i = 0; i < filterButtons.length; i++) {
    filterButtons[i].addEventListener('click', function () {
      state.filter = this.getAttribute('data-filter')
      render()
    })
  }

  els.createForm.addEventListener('submit', createTodo)
  els.detailSave.addEventListener('click', saveDetail)
  els.detailDelete.addEventListener('click', function () {
    var todo = selectedTodo()
    if (todo) removeTodo(todo)
  })
  els.detailToggle.addEventListener('click', function () {
    var todo = selectedTodo()
    if (todo) toggleTodo(todo)
  })
  els.detailClose.addEventListener('click', function () {
    state.selectedId = null
    lastDetailKey = ''
    render()
  })
  els.detailGroup.addEventListener('change', saveDetail)
  els.detailPriority.addEventListener('change', saveDetail)
  els.detailDue.addEventListener('change', saveDetail)

  window.proma.on('planning:changed', function (change) {
    var resources = change && change.resources ? change.resources : []
    if (resources.length === 0 || resources.indexOf('todos') >= 0 || resources.indexOf('todo_groups') >= 0 || resources.indexOf('reminders') >= 0) {
      load()
    }
  })

  window.proma.ready.then(load)
})()
