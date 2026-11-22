/**
 * 插件 UI 与 Proma 宿主之间的桥接脚本。
 *
 * 同一个脚本有两份运行环境：
 * 1. Proma 通过 proma-plugin:// 加载插件页面，脚本用 postMessage 请求宿主执行 Planning API；
 * 2. 独立预览服务器加载插件页面，脚本使用 localStorage 中的模拟数据，便于不启动
 *    Electron 开发环境时调试插件界面。
 */

export const PLUGIN_UI_BRIDGE_SCRIPT = String.raw`(function () {
  if (window.proma && window.proma.__promaBridge) return

  var embedded = Boolean(window.parent && window.parent !== window)
  var pending = Object.create(null)
  var seq = 0
  var listeners = Object.create(null)
  var context = { workspaceSlug: null, workspaceId: null, theme: 'light' }
  var readyResolve
  var ready = new Promise(function (resolve) { readyResolve = resolve })

  function emit(name, payload) {
    var list = listeners[name]
    if (!list) return
    list.slice().forEach(function (fn) {
      try { fn(payload) } catch (error) { console.error('[proma] 事件处理失败:', error) }
    })
  }

  function on(name, fn) {
    var list = listeners[name] || (listeners[name] = [])
    list.push(fn)
    return function () {
      var index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    }
  }

  function request(method, params) {
    if (!embedded) return mockRequest(method, params)
    return new Promise(function (resolve, reject) {
      var id = 'req-' + (++seq) + '-' + Date.now()
      pending[id] = { resolve: resolve, reject: reject }
      window.parent.postMessage({
        source: 'proma-plugin',
        type: 'request',
        id: id,
        method: method,
        params: params || {}
      }, '*')
    })
  }

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data || data.source !== 'proma-plugin-host') return
    if (data.type === 'response') {
      var entry = pending[data.id]
      if (!entry) return
      delete pending[data.id]
      if (data.ok) entry.resolve(data.result)
      else entry.reject(new Error(data.error || '插件请求失败'))
      return
    }
    if (data.type === 'event') {
      emit(data.event, data.payload)
      return
    }
    if (data.type === 'context') {
      context = Object.assign(context, data.context || {})
      document.documentElement.setAttribute('data-proma-theme', context.theme || 'light')
      if (readyResolve) { readyResolve(); readyResolve = null }
    }
  })

  // ===== 独立预览的模拟 Planning 存储 =====
  var STORAGE_KEY = 'proma-plugin-preview:v1'

  function readStore() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) : null
    } catch (error) {
      return null
    }
  }

  function writeStore(store) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)) } catch (error) { /* 忽略预览存储失败 */ }
  }

  function uid(prefix) {
    return prefix + '-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  }

  function seedStore() {
    var now = Date.now()
    var today = new Date()
    today.setHours(9, 0, 0, 0)
    var tomorrow = new Date(today.getTime() + 86400000)
    return {
      groups: [
        { id: 'group-work', scope: 'todo', name: '工作', color: '#3b82f6', sortOrder: 0, createdAt: now, updatedAt: now },
        { id: 'group-life', scope: 'todo', name: '生活', color: '#10b981', sortOrder: 1, createdAt: now, updatedAt: now },
        { id: 'group-calendar', scope: 'calendar', name: '默认日程', color: '#8b5cf6', sortOrder: 0, createdAt: now, updatedAt: now }
      ],
      tags: [],
      todos: [
        { id: 'todo-preview-1', title: '体验 Proma Todo 插件', notes: '可以编辑、完成或删除这条任务。', status: 'open', priority: 'high', dueAt: today.getTime() + 3600000, groupId: 'group-work', tags: [], reminders: [], sessionLinks: [], createdAt: now, updatedAt: now },
        { id: 'todo-preview-2', title: '整理本周计划', status: 'open', priority: 'medium', groupId: 'group-life', tags: [], reminders: [], sessionLinks: [], createdAt: now, updatedAt: now }
      ],
      events: [
        { id: 'event-preview-1', title: '插件开发评审', startAt: today.getTime() + 7200000, endAt: today.getTime() + 10800000, allDay: false, groupId: 'group-calendar', tags: [], reminders: [], createdAt: now, updatedAt: now },
        { id: 'event-preview-2', title: '整理下周日程', startAt: tomorrow.getTime() + 3600000, endAt: tomorrow.getTime() + 7200000, allDay: false, groupId: 'group-calendar', tags: [], reminders: [], createdAt: now, updatedAt: now }
      ]
    }
  }

  function getStore() {
    var store = readStore()
    if (!store) { store = seedStore(); writeStore(store) }
    if (!store.groups) store.groups = []
    if (!store.tags) store.tags = []
    if (!store.todos) store.todos = []
    if (!store.events) store.events = []
    return store
  }

  function hydrateTodo(store, todo) {
    return Object.assign({}, todo, {
      group: store.groups.find(function (group) { return group.id === todo.groupId }) || undefined,
      tags: store.tags.filter(function (tag) { return (todo.tagIds || []).indexOf(tag.id) >= 0 })
    })
  }

  function hydrateEvent(store, event) {
    return Object.assign({}, event, {
      group: store.groups.find(function (group) { return group.id === event.groupId }) || undefined,
      tags: store.tags.filter(function (tag) { return (event.tagIds || []).indexOf(tag.id) >= 0 })
    })
  }

  function mockRequest(method, params) {
    params = params || {}
    var store = getStore()
    var now = Date.now()
    try {
      if (method === 'plugin.getContext') {
        return Promise.resolve({ workspaceSlug: 'preview', workspaceId: null, preview: true, theme: context.theme })
      }
      if (method === 'planning.listTodos') {
        var todos = store.todos.filter(function (todo) {
          return !params.status || todo.status === params.status
        })
        if (params.limit) todos = todos.slice(0, params.limit)
        return Promise.resolve(todos.map(function (todo) { return hydrateTodo(store, todo) }))
      }
      if (method === 'planning.createTodo') {
        if (!params.title) throw new Error('Todo 标题不能为空')
        var todo = {
          id: uid('todo'), title: params.title, notes: params.notes || '', status: 'open',
          priority: params.priority || 'medium', dueAt: params.dueAt, groupId: params.groupId,
          tagIds: params.tagIds || [], tags: [], reminders: [], sessionLinks: [],
          workspaceId: params.workspaceId, createdAt: now, updatedAt: now
        }
        store.todos.unshift(todo)
        writeStore(store)
        emit('planning:changed', { resources: ['todos', 'reminders'], todo: hydrateTodo(store, todo) })
        return Promise.resolve(hydrateTodo(store, todo))
      }
      if (method === 'planning.updateTodo') {
        var current = store.todos.find(function (item) { return item.id === params.id })
        if (!current) throw new Error('Todo 不存在')
        Object.keys(params).forEach(function (key) {
          if (key === 'id' || key === 'expectedUpdatedAt') return
          if (key === 'dueAt' || key === 'groupId' || key === 'workspaceId' || key === 'todoId') current[key] = params[key]
          else current[key] = params[key]
        })
        if (current.status === 'completed') current.completedAt = now
        current.updatedAt = now
        writeStore(store)
        emit('planning:changed', { resources: ['todos', 'reminders'], todo: hydrateTodo(store, current) })
        return Promise.resolve(hydrateTodo(store, current))
      }
      if (method === 'planning.deleteTodo') {
        store.todos = store.todos.filter(function (item) { return item.id !== params.id })
        writeStore(store)
        emit('planning:changed', { resources: ['todos', 'calendar_events', 'reminders'] })
        return Promise.resolve(true)
      }
      if (method === 'planning.listCalendarEvents') {
        var events = store.events.filter(function (event) {
          if (params.from && event.startAt < params.from) return false
          if (params.to && event.startAt > params.to) return false
          return true
        })
        if (params.limit) events = events.slice(0, params.limit)
        return Promise.resolve(events.map(function (event) { return hydrateEvent(store, event) }))
      }
      if (method === 'planning.createCalendarEvent') {
        if (!params.title || !params.startAt) throw new Error('日程标题和开始时间必填')
        var event = {
          id: uid('event'), title: params.title, notes: params.notes || '',
          startAt: params.startAt, endAt: params.endAt, allDay: Boolean(params.allDay),
          groupId: params.groupId, tagIds: params.tagIds || [], tags: [], reminders: [],
          workspaceId: params.workspaceId, createdAt: now, updatedAt: now
        }
        store.events.push(event)
        writeStore(store)
        emit('planning:changed', { resources: ['calendar_events', 'reminders'] })
        return Promise.resolve(hydrateEvent(store, event))
      }
      if (method === 'planning.updateCalendarEvent') {
        var existing = store.events.find(function (item) { return item.id === params.id })
        if (!existing) throw new Error('日程不存在')
        Object.keys(params).forEach(function (key) {
          if (key === 'id' || key === 'expectedUpdatedAt') return
          existing[key] = params[key]
        })
        existing.updatedAt = now
        writeStore(store)
        emit('planning:changed', { resources: ['calendar_events', 'reminders'] })
        return Promise.resolve(hydrateEvent(store, existing))
      }
      if (method === 'planning.deleteCalendarEvent') {
        store.events = store.events.filter(function (item) { return item.id !== params.id })
        writeStore(store)
        emit('planning:changed', { resources: ['calendar_events', 'reminders'] })
        return Promise.resolve(true)
      }
      if (method === 'planning.listGroups') {
        return Promise.resolve(store.groups.filter(function (group) { return group.scope === params.scope }))
      }
      if (method === 'planning.listTags') return Promise.resolve(store.tags)
      return Promise.reject(new Error('预览模式不支持方法: ' + method))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  window.proma = {
    __promaBridge: true,
    ready: ready,
    get context() { return context },
    request: request,
    on: on,
    planning: {
      listTodos: function (query) { return request('planning.listTodos', query || {}) },
      createTodo: function (input) { return request('planning.createTodo', input || {}) },
      updateTodo: function (input) { return request('planning.updateTodo', input || {}) },
      deleteTodo: function (id) { return request('planning.deleteTodo', { id: id }) },
      listCalendarEvents: function (query) { return request('planning.listCalendarEvents', query || {}) },
      createCalendarEvent: function (input) { return request('planning.createCalendarEvent', input || {}) },
      updateCalendarEvent: function (input) { return request('planning.updateCalendarEvent', input || {}) },
      deleteCalendarEvent: function (id) { return request('planning.deleteCalendarEvent', { id: id }) },
      listGroups: function (scope) { return request('planning.listGroups', { scope: scope }) },
      listTags: function () { return request('planning.listTags', {}) }
    }
  }

  if (embedded) {
    window.parent.postMessage({ source: 'proma-plugin', type: 'ready' }, '*')
  } else {
    document.documentElement.setAttribute('data-proma-theme', context.theme)
    if (readyResolve) { readyResolve(); readyResolve = null }
  }
})()`
