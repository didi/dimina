// event/custom-comp.js
Component({
  methods: {
    bindComponentTap: function (e) {
      console.log('触发了自定义组件内部的 tap 事件，e.mark = ' + JSON.stringify(e.mark))
    }
  }
})
