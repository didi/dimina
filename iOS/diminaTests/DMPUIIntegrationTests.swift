import Testing

// These suites share UIApplication windows, the WebView pool, and app-manager
// state. Serializing each child alone still allows it to overlap its siblings,
// starving WebGL's synchronous reply while navigation/teardown runs on main.
@Suite(.serialized)
struct DMPUIIntegrationTests {}
