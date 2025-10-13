# Waveform Viewer - Refactored Architecture

## 📋 概述

这是波形图查看器的重构版本，采用了清晰的模块化架构和TypeScript实现，提供了更好的可维护性和扩展性。

## 🏗️ 架构设计

### 核心模块

```
waveform/
├── types.ts                  # 类型定义
├── renderer-base.ts          # 渲染器基类
├── webgl-renderer.ts         # WebGL渲染器
├── canvas2d-renderer.ts      # Canvas 2D渲染器
├── data-provider.ts          # 数据提供者
├── webview-manager.ts        # WebView管理器
├── waveform-client.ts        # 客户端主逻辑
├── waveform.html            # HTML模板
├── index.ts                 # 模块导出
└── README.md                # 本文档
```

### 设计原则

1. **关注点分离**: 渲染、数据管理、UI逻辑完全分离
2. **接口抽象**: 使用接口定义清晰的契约
3. **类型安全**: 全面使用TypeScript类型系统
4. **可扩展性**: 易于添加新的渲染器或数据源

## 🔧 核心组件

### 1. 类型定义 (`types.ts`)

定义了所有核心数据结构和接口：

- `WaveformVariable`: 波形变量定义
- `WaveformDataPoint`: 数据点结构
- `WaveformSettings`: 配置选项
- `IRenderer`: 渲染器接口
- `ViewPort`: 视图窗口
- `UIState`: UI状态

### 2. 渲染器系统

#### 基类 (`renderer-base.ts`)

提供通用功能：
- 性能监控
- 坐标转换
- 数据降采样 (LTTB算法)
- 自动缩放

#### WebGL渲染器 (`webgl-renderer.ts`)

特性：
- 硬件加速渲染
- 高性能着色器
- 大数据量优化
- 抗锯齿支持

#### Canvas 2D渲染器 (`canvas2d-renderer.ts`)

特性：
- 标准Canvas API
- 更好的兼容性
- 简单的实现
- 线条样式支持

### 3. 数据管理

#### 数据提供者 (`data-provider.ts`)

功能：
- 变量管理（添加/删除/查询）
- 数据收集和存储
- 录制控制
- 数据导出 (JSON/CSV)
- 自动清理过期数据

接口：
```typescript
interface IWaveformDataProvider {
    addVariable(expression: string, name: string): boolean;
    removeVariable(variableId: string): boolean;
    getVariables(): WaveformVariable[];
    startRecording(): void;
    stopRecording(): void;
    exportData(format: 'json' | 'csv'): string;
}
```

### 4. WebView管理

#### WebView管理器 (`webview-manager.ts`)

负责：
- 创建和管理WebView面板
- 加载HTML内容
- 处理消息通信
- 自动更新数据
- 导出功能

### 5. 客户端逻辑

#### 客户端 (`waveform-client.ts`)

功能：
- 初始化渲染器
- 处理用户交互
- 管理UI状态
- 渲染循环
- 性能监控

## 🚀 使用方式

### 在扩展中使用

```typescript
import { WaveformDataProvider, WaveformWebViewManager } from './views/waveform';

// 创建数据提供者
const dataProvider = new WaveformDataProvider({
    refreshRate: 1.0,
    timeSpan: 60,
    renderer: 'webgl'
});

// 创建WebView管理器
const webviewManager = new WaveformWebViewManager(context, dataProvider);

// 显示波形图
webviewManager.show();

// 添加变量
webviewManager.addVariable('myVar', 'My Variable');
```

### 添加新渲染器

1. 继承 `RendererBase`
2. 实现抽象方法
3. 在 `waveform-client.ts` 中注册

```typescript
export class MyCustomRenderer extends RendererBase {
    public initialize(): void { /* ... */ }
    public render(/* ... */): void { /* ... */ }
    public clear(): void { /* ... */ }
    public dispose(): void { /* ... */ }
}
```

## 📊 性能优化

### 数据降采样

使用 LTTB (Largest Triangle Three Buckets) 算法：
- 保持数据特征
- 减少顶点数量
- 提高渲染性能

### 渲染优化

- WebGL批处理
- 视口裁剪
- 增量更新
- 请求动画帧优化

### 内存管理

- 自动清理过期数据
- 限制最大数据点数
- 及时释放GPU资源

## 🎨 可配置选项

```typescript
interface WaveformSettings {
    timeSpan: number;           // 时间跨度（秒）
    refreshRate: number;        // 刷新率（Hz）
    maxDataPoints: number;      // 最大数据点数
    yAxisMode: 'auto' | 'manual'; // Y轴模式
    yMin: number | null;        // Y轴最小值
    yMax: number | null;        // Y轴最大值
    showGrid: boolean;          // 显示网格
    showLegend: boolean;        // 显示图例
    colorScheme: string;        // 配色方案
    renderer: 'webgl' | 'canvas2d'; // 渲染器类型
}
```

## 🔄 迁移指南

### 从旧版本迁移

旧代码:
```typescript
// 旧的方式
import { WaveformWebviewPanel } from './waveform-webview';
const panel = new WaveformWebviewPanel(context, liveWatch, dataProvider);
```

新代码:
```typescript
// 新的方式
import { WaveformDataProvider, WaveformWebViewManager } from './views/waveform';
const dataProvider = new WaveformDataProvider();
const manager = new WaveformWebViewManager(context, dataProvider);
```

### 主要变更

1. ✅ 统一的类型系统
2. ✅ 清晰的接口定义
3. ✅ 模块化架构
4. ✅ 完整的TypeScript支持
5. ✅ 更好的性能

## 🐛 调试

### 启用调试日志

```typescript
// 在浏览器控制台
localStorage.setItem('waveform-debug', 'true');
```

### 性能监控

内置性能指标：
- FPS (帧率)
- 渲染时间
- 顶点数量
- 绘制调用次数

## 📝 待办事项

- [ ] FFT分析功能
- [ ] 更多配色方案
- [ ] 触发器功能
- [ ] 数据回放
- [ ] 多视图支持

## 🤝 贡献

欢迎贡献代码！请遵循以下规范：

1. 使用TypeScript
2. 遵循现有代码风格
3. 添加适当的注释
4. 更新相关文档

## 📄 许可证

与主项目保持一致


