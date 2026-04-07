// my-behavior.js

module.exports = Behavior({
  behaviors: [],
  properties: {
    myBehaviorProperty: {
      type: String
    }
  },
  data: {
    myBehaviorData: 'my-behavior-data'
  },
  created: function () {
    console.log('[my-behavior] created')
  },
  attached: function () {
    console.log('[my-behavior] attached')
  },
  ready: function () {
    console.log('[my-behavior] ready')
  },

  methods: {
    myBehaviorMethod: function () {
      console.log('[my-behavior] log by myBehaviorMehtod')
    },
  }
})