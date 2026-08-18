// MiniApp unit tests do not start the service Worker. Keep its generated bundle
// out of module collection so workspace tests do not depend on build ordering.
export default 'data:text/javascript,'
