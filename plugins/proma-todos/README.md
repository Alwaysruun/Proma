# Proma Todo 插件

在 Proma 左侧栏注册 Todo 入口，使用本地 Planning 数据库。

## 开发预览

不用启动 Electron 开发环境：

```bash
bun run plugins:preview plugins/proma-todos
```

浏览器打开命令输出的地址即可。预览模式的数据保存在 localStorage，不会写入 Proma 数据库。

## 安装

Proma → 插件 → 从文件夹安装，选择本目录。安装后左侧栏 Todo 入口会切换为插件界面；卸载后回退到内置视图。
