# TypeScript、Less 和 SCSS 编译支持

Dimina 编译器现在支持 TypeScript、Less 和 SCSS 文件的编译，为开发者提供更强大的开发体验。

## 功能特性

### TypeScript 支持

- **文件扩展名**: `.ts`
- **自动编译**: TypeScript 文件会自动编译为 JavaScript
- **类型检查**: 基本的 TypeScript 语法支持
- **错误处理**: 编译失败时会回退到原始代码

#### 支持的 TypeScript 编译选项

```json
{
  "target": "ES2020",
  "module": "CommonJS",
  "strict": false,
  "esModuleInterop": true,
  "skipLibCheck": true
}
```

#### Import 语句支持

编译器现在支持 ES6 import 语句，包括：

- **相对路径导入**：`import { utils } from './utils'`
- **npm 包导入**：`import Toast from '@vant/weapp/toast/toast'`
- **绝对路径导入**：`import { api } from '/utils/api'`

**Import 语句示例**：

```typescript
// 相对路径导入
import { formatDate } from '../../utils/helper'

// npm 包导入
import Toast from '@vant/weapp/toast/toast'
import Dialog from '@vant/weapp/dialog/dialog'

// 绝对路径导入
import { request } from '/utils/api'

Page({
  async onLoad() {
    const now = formatDate(new Date())
    
    Toast.show({
      message: '页面加载完成'
    })
    
    const confirmed = await Dialog.confirm({
      title: '提示',
      message: '确认操作吗？'
    })
    
    if (confirmed) {
      const result = await request('/api/data', {})
      console.log('请求结果:', result)
    }
  }
})
```

#### 使用示例

**页面文件 (pages/index/index.ts)**:
```typescript
interface PageData {
  message: string;
  count: number;
}

Page<PageData>({
  data: {
    message: 'Hello TypeScript',
    count: 0
  },
  
  onLoad(): void {
    console.log('Page loaded with TypeScript')
  },
  
  increment(): void {
    this.setData({
      count: this.data.count + 1
    })
  }
})
```

**组件文件 (components/my-component/index.ts)**:
```typescript
interface ComponentData {
  title: string;
  visible: boolean;
}

interface ComponentMethods {
  toggle(): void;
  show(): void;
  hide(): void;
}

Component<ComponentData, {}, ComponentMethods>({
  data: {
    title: 'TypeScript Component',
    visible: false
  },
  
  methods: {
    toggle(): void {
      this.setData({
        visible: !this.data.visible
      })
    },
    
    show(): void {
      this.setData({ visible: true })
    },
    
    hide(): void {
      this.setData({ visible: false })
    }
  }
})
```

### Less 支持

- **文件扩展名**: `.less`
- **变量支持**: 支持 Less 变量和 mixin
- **嵌套支持**: 支持 CSS 嵌套语法
- **函数支持**: 支持 Less 内置函数

#### 使用示例

```less
@primary-color: #1890ff;
@border-radius: 4px;

.container {
  background-color: @primary-color;
  border-radius: @border-radius;
  
  .header {
    font-size: 18px;
    font-weight: bold;
    
    &:hover {
      opacity: 0.8;
    }
  }
  
  .content {
    padding: 16px;
    
    p {
      margin: 0;
      line-height: 1.5;
    }
  }
}

.mixin-example() {
  display: flex;
  align-items: center;
  justify-content: center;
}

.button {
  .mixin-example();
  padding: 8px 16px;
  background: lighten(@primary-color, 10%);
}
```

### SCSS/Sass 支持

- **文件扩展名**: `.scss`, `.sass`
- **变量支持**: 支持 SCSS 变量和 mixin
- **嵌套支持**: 支持 CSS 嵌套语法
- **模块系统**: 支持 `@use` 和 `@import`

#### SCSS 使用示例

```scss
@use "sass:color";

$primary-color: #ff6b35;
$secondary-color: #f7931e;
$border-radius: 8px;

@mixin button-style($bg-color) {
  background-color: $bg-color;
  border: none;
  border-radius: $border-radius;
  padding: 12px 24px;
  cursor: pointer;
  
  &:hover {
    background-color: color.adjust($bg-color, $lightness: -10%);
  }
}

.page {
  background: linear-gradient(45deg, $primary-color, $secondary-color);
  min-height: 100vh;
  
  .nav {
    display: flex;
    justify-content: space-between;
    padding: 16px;
    
    &__logo {
      font-size: 24px;
      font-weight: bold;
      color: white;
    }
    
    &__menu {
      display: flex;
      gap: 16px;
      
      a {
        color: white;
        text-decoration: none;
        
        &:hover {
          text-decoration: underline;
        }
      }
    }
  }
  
  .btn {
    &--primary {
      @include button-style($primary-color);
    }
    
    &--secondary {
      @include button-style($secondary-color);
    }
  }
}
```

#### Sass 缩进语法示例

```sass
$primary: #42b983
$margin: 16px

.container
  background: $primary
  margin: $margin
  
  .title
    font-size: 24px
    color: white
    
    &:hover
      opacity: 0.8
  
  .list
    padding: $margin
    
    li
      margin-bottom: 8px
      
      &:last-child
        margin-bottom: 0
```

## 编译流程

### 文件查找优先级

编译器在查找文件时会按以下优先级进行：

1. **逻辑文件**: `.js` → `.ts`
2. **样式文件**: `.wxss` → `.ddss` → `.less` → `.scss` → `.sass`

### 错误处理

- **TypeScript 编译失败**: 会回退到原始代码继续处理
- **Less/SCSS 编译失败**: 会记录错误并使用原始内容
- **PostCSS 解析失败**: 会返回空字符串，避免整个编译流程中断

### 性能优化

- **缓存机制**: 编译结果会被缓存，避免重复编译
- **并行处理**: 不同类型的文件可以并行编译
- **增量编译**: 只编译修改过的文件

## 配置要求

### package.json 依赖

```json
{
  "dependencies": {
    "less": "^4.2.1",
    "sass": "^1.81.0",
    "typescript": "^5.7.2"
  }
}
```

### 项目结构示例

```
project/
├── pages/
│   └── index/
│       ├── index.ts          # TypeScript 页面逻辑
│       ├── index.scss        # SCSS 样式
│       ├── index.wxml        # 页面模板
│       └── index.json        # 页面配置
├── components/
│   └── my-component/
│       ├── index.ts          # TypeScript 组件逻辑
│       ├── index.less        # Less 样式
│       ├── index.wxml        # 组件模板
│       └── index.json        # 组件配置
├── app.json
└── project.config.json
```

## 注意事项

1. **TypeScript 配置**: 编译器使用内置的 TypeScript 配置，不支持自定义 `tsconfig.json`
2. **样式作用域**: 编译后的样式会自动添加作用域，避免样式冲突
3. **文件命名**: 保持与微信小程序的文件命名约定一致
4. **兼容性**: 完全向后兼容，现有的 `.js` 和 `.wxss` 文件继续正常工作

## 测试覆盖

- **TypeScript 编译测试**: 3个测试用例，覆盖页面、组件和错误处理
- **样式预处理器测试**: 覆盖 Less、SCSS 和 Sass 的基本编译功能
- **错误处理测试**: 确保编译失败时不会中断整个构建流程

通过这些新功能，开发者可以使用现代的前端开发工具和语法来开发微信小程序，提高开发效率和代码质量。 