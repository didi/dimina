# selectComponent 使用指南

`selectComponent` 是小程序中用于获取子组件实例的方法，既可以在自定义组件中使用，也可以在页面中使用。参考[微信小程序官方文档](https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/events.html#获取组件实例)。

## 在页面中使用

### 1. 页面中使用 ID 选择器

```javascript
// 页面
Page({
  data: {},
  onReady: function () {
    // 页面渲染完成后可以获取组件实例
    const myComponent = this.selectComponent('#my-component');
    console.log(myComponent); // 获取页面中 id 为 my-component 的组件实例
  }
})
```

```xml
<!-- 页面模板 -->
<view class="container">
  <my-component id="my-component"></my-component>
  <another-component class="my-class"></another-component>
</view>
```

### 2. 页面中使用类选择器

```javascript
// 页面
Page({
  data: {},
  onReady: function () {
    const myComponent = this.selectComponent('.my-class');
    console.log(myComponent); // 获取页面中第一个 class 包含 my-class 的组件实例
  }
})
```

### 3. 页面中获取多个组件

```javascript
// 页面
Page({
  data: {},
  onReady: function () {
    const components = this.selectAllComponents('.my-class');
    console.log(components); // 获取页面中所有 class 包含 my-class 的组件实例数组
  }
})
```

## 在自定义组件中使用

### 1. 组件中使用 ID 选择器

```javascript
// 父组件
Component({
  methods: {
    getChildComponent: function () {
      const child = this.selectComponent('#my-component');
      console.log(child); // 获取 id 为 my-component 的子组件实例
    }
  }
})
```

```xml
<!-- 父组件模板 -->
<my-component id="my-component"></my-component>
<button bindtap="getChildComponent">获取子组件</button>
```

### 2. 组件中使用类选择器

```javascript
// 父组件
Component({
  methods: {
    getChildComponent: function () {
      const child = this.selectComponent('.my-class');
      console.log(child); // 获取 class 包含 my-class 的第一个子组件实例
    }
  }
})
```

```xml
<!-- 父组件模板 -->
<my-component class="my-class"></my-component>
<button bindtap="getChildComponent">获取子组件</button>
```

### 3. 标签选择器

```javascript
// 父组件
Component({
  methods: {
    getChildComponent: function () {
      const child = this.selectComponent('my-component');
      console.log(child); // 获取第一个 my-component 组件实例
    }
  }
})
```

### 4. 属性选择器

```javascript
// 父组件
Component({
  methods: {
    getChildComponent: function () {
      const child = this.selectComponent('[data-type="button"]');
      console.log(child); // 获取 data-type 为 button 的第一个子组件实例
    }
  }
})
```

```xml
<!-- 父组件模板 -->
<my-component data-type="button"></my-component>
<button bindtap="getChildComponent">获取子组件</button>
```

## 自定义返回值

使用 `wx://component-export` behavior 可以自定义 `selectComponent` 的返回值：

```javascript
// 子组件
Component({
  behaviors: ['wx://component-export'],
  export() {
    return { 
      myField: 'myValue',
      customMethod: this.customMethod.bind(this)
    }
  },
  methods: {
    customMethod() {
      console.log('自定义方法被调用');
    }
  }
})
```

```javascript
// 父组件或页面
Page({
  onReady: function () {
    const child = this.selectComponent('#the-id');
    console.log(child); // { myField: 'myValue', customMethod: function }
    child.customMethod(); // 调用自定义方法
  }
})
```

## 选择器语法

| 选择器类型 | 语法 | 示例 | 说明 |
|----------|------|------|------|
| ID 选择器 | `#id` | `#my-component` | 匹配 id 为 my-component 的组件 |
| 类选择器 | `.class` | `.my-class` | 匹配 class 包含 my-class 的组件 |
| 标签选择器 | `tag-name` | `my-component` | 匹配组件名为 my-component 的组件 |
| 属性选择器 | `[attr=value]` | `[data-type="button"]` | 匹配指定属性值的组件 |
| 属性存在选择器 | `[attr]` | `[data-type]` | 匹配具有指定属性的组件 |

## 注意事项

1. **只能选择子组件**：
   - 在页面中使用时，只能选择页面中的组件实例
   - 在组件中使用时，只能选择当前组件的子组件（包括深层嵌套的子组件）

2. **返回第一个匹配的组件**：如果有多个组件匹配选择器，只返回第一个匹配的组件。如需获取所有匹配的组件，请使用 `selectAllComponents`。

3. **插件和小程序之间的限制**：默认情况下，小程序与插件之间、不同插件之间的组件无法通过 `selectComponent` 获取。

4. **生命周期时机**：
   - 在页面中，建议在 `onReady` 生命周期之后调用，以保证页面和组件都已经渲染完成
   - 在组件中，建议在 `ready` 生命周期之后调用，以保证子组件已经创建完成

5. **性能考虑**：`selectComponent` 会遍历所有实例进行匹配，建议合理使用，避免在频繁调用的方法中使用。

## 相关方法

- `selectAllComponents(selector)`: 获取所有匹配选择器的子组件实例数组
- `selectOwnerComponent()`: 获取当前组件的引用者（父组件）实例（仅在组件中可用）
- `createSelectorQuery()`: 创建 SelectorQuery 对象，用于查询节点信息

## 使用场景

### 1. 页面控制组件

```javascript
// 页面
Page({
  data: {
    items: []
  },
  onReady: function () {
    // 获取列表组件并设置数据
    const listComponent = this.selectComponent('#list-component');
    if (listComponent) {
      listComponent.setData({
        items: this.data.items
      });
    }
  }
})
```

### 2. 组件间通信

```javascript
// 父组件
Component({
  methods: {
    onButtonClick: function () {
      // 点击按钮时控制子组件
      const childComponent = this.selectComponent('.child-component');
      if (childComponent) {
        childComponent.show(); // 调用子组件的方法
      }
    }
  }
})
```

### 3. 表单验证

```javascript
// 页面
Page({
  data: {},
  onSubmit: function () {
    // 获取所有表单组件进行验证
    const formComponents = this.selectAllComponents('.form-item');
    let isValid = true;
    
    formComponents.forEach(component => {
      if (!component.validate()) {
        isValid = false;
      }
    });
    
    if (isValid) {
      // 提交表单
      console.log('表单验证通过');
    }
  }
})
```

## 示例项目

完整的示例代码可以在测试文件中找到：
- 组件测试：`__tests__/select-component.spec.js`
- 页面测试：`__tests__/page-select-component.spec.js` 