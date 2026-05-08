// components/component-tag-name.js
Component({
  properties: {},
  methods: {
    onTap: function () {
      this.triggerEvent('customevent', {}) // 只会触发 pageEventListener2
      console.log('----------------')
      this.triggerEvent('customevent', {}, { bubbles: true }) // 会依次触发 pageEventListener2 、 pageEventListener1
      console.log('----------------')
      this.triggerEvent('customevent', {}, { bubbles: true, composed: true }) // 会依次触发 pageEventListener2 、 anotherEventListener 、 pageEventListener1
    }
  }
})