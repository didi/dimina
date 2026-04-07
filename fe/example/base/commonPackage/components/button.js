Component({
  options: {
    styleIsolation: 'isolated'
  },
  lifetimes: {
    attached() {
      this.triggerEvent('attached')
    }
  },
  methods: {
    clicked() {
      this.triggerEvent('clicked')
    }
  }
})