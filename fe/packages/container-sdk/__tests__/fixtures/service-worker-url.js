// container-sdk 单测不启动真实的逻辑线程 Worker（见 fixtures/fake-worker.js），
// 这里只需要给 `@dimina/service?url` 一个可解析的占位 URL，避免测试依赖构建产物。
// 与 fe/packages/container/__tests__/fixtures/service-worker-url.js 同一手法。
export default 'data:text/javascript,'
