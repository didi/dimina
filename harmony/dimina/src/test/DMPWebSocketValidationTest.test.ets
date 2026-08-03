import { describe, it, expect } from '@ohos/hypium';
import { DMPWebSocketValidation } from '../main/ets/Bridges/Network/DMPWebSocketManager';

/**
 * 覆盖 connectSocket/closeSocket 的纯函数校验。
 */
export default function dmpWebSocketValidationTest() {
  describe('DMPWebSocketValidationTest', () => {
    // ---------------- url ----------------
    it('url_rejects_non_ws_scheme', 0, () => {
      const r = DMPWebSocketValidation.validateUrl('https://example.com/socket');
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid url');
    });

    it('url_rejects_fragment', 0, () => {
      const r = DMPWebSocketValidation.validateUrl('wss://example.com/socket#frag');
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid url');
    });

    it('url_rejects_malformed', 0, () => {
      const r = DMPWebSocketValidation.validateUrl('not a url');
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid url');
    });

    it('url_rejects_missing_or_non_string', 0, () => {
      expect(DMPWebSocketValidation.validateUrl(undefined).ok).assertFalse();
      expect(DMPWebSocketValidation.validateUrl(123).ok).assertFalse();
    });

    it('url_accepts_ws_and_wss', 0, () => {
      const ws = DMPWebSocketValidation.validateUrl('ws://example.com:8080/path');
      expect(ws.ok).assertTrue();
      expect(ws.scheme).assertEqual('ws:');
      expect(ws.host).assertEqual('example.com:8080');

      const wss = DMPWebSocketValidation.validateUrl('wss://example.com/path');
      expect(wss.ok).assertTrue();
      expect(wss.scheme).assertEqual('wss:');
    });

    it('url_rejects_invalid_host_characters', 0, () => {
      // 之前用宽松正则放行、真正失败要等深到 SDK 内部才报错；现在必须在
      // connectSocket 校验阶段就同步拒绝，对齐 Android/iOS。
      const r = DMPWebSocketValidation.validateUrl('ws://bad host/path');
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid url');
    });

    it('url_strips_userinfo_from_host_for_origin', 0, () => {
      // host 只应包含 host[:port]，不应包含 userinfo/凭据（否则 Origin 头会泄漏凭据）。
      const r = DMPWebSocketValidation.validateUrl('ws://user:pass@example.com:8080/path');
      expect(r.ok).assertTrue();
      expect(r.host).assertEqual('example.com:8080');
    });

    // ---------------- timeout ----------------
    it('timeout_default_when_missing', 0, () => {
      const r = DMPWebSocketValidation.validateTimeout(undefined);
      expect(r.ok).assertTrue();
      expect(r.value).assertEqual(60000);
    });

    it('timeout_falls_back_when_non_positive', 0, () => {
      const zero = DMPWebSocketValidation.validateTimeout(0);
      expect(zero.ok).assertTrue();
      expect(zero.value).assertEqual(60000);

      const negative = DMPWebSocketValidation.validateTimeout(-10);
      expect(negative.ok).assertTrue();
      expect(negative.value).assertEqual(60000);
    });

    it('timeout_rejects_non_finite', 0, () => {
      const r = DMPWebSocketValidation.validateTimeout(Number.NaN);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid timeout');

      const inf = DMPWebSocketValidation.validateTimeout(Number.POSITIVE_INFINITY);
      expect(inf.ok).assertFalse();
    });

    it('timeout_rejects_over_max', 0, () => {
      const r = DMPWebSocketValidation.validateTimeout(0x7fffffff + 1);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid timeout');
    });

    it('timeout_truncates_positive', 0, () => {
      const r = DMPWebSocketValidation.validateTimeout(1500.7);
      expect(r.ok).assertTrue();
      expect(r.value).assertEqual(1500);
    });

    // ---------------- protocols ----------------
    it('protocols_default_empty', 0, () => {
      const r = DMPWebSocketValidation.validateProtocols(undefined);
      expect(r.ok).assertTrue();
      expect(r.value.length).assertEqual(0);
    });

    it('protocols_rejects_non_array', 0, () => {
      const r = DMPWebSocketValidation.validateProtocols('chat');
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('protocols must be an array');
    });

    it('protocols_rejects_empty_or_non_string_items', 0, () => {
      const empty = DMPWebSocketValidation.validateProtocols(['chat', '']);
      expect(empty.ok).assertFalse();
      expect(empty.errMsg).assertEqual('invalid protocol');

      const nonString = DMPWebSocketValidation.validateProtocols(['chat', 1]);
      expect(nonString.ok).assertFalse();
      expect(nonString.errMsg).assertEqual('invalid protocol');
    });

    it('protocols_accepts_valid_list', 0, () => {
      const r = DMPWebSocketValidation.validateProtocols(['chat', 'superchat']);
      expect(r.ok).assertTrue();
      expect(r.value.length).assertEqual(2);
    });

    // ---------------- header ----------------
    it('header_rejects_non_object', 0, () => {
      const r = DMPWebSocketValidation.validateHeader(['a']);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('header must be an object');

      const r2 = DMPWebSocketValidation.validateHeader('str');
      expect(r2.ok).assertFalse();
    });

    it('header_silently_drops_disallowed_names', 0, () => {
      const r = DMPWebSocketValidation.validateHeader({
        'Host': 'evil.com',
        'Sec-WebSocket-Key': 'x',
        'X-Custom': 'ok',
      });
      expect(r.ok).assertTrue();
      expect(r.value.has('Host')).assertFalse();
      expect(r.value.has('Sec-WebSocket-Key')).assertFalse();
      expect(r.value.get('X-Custom')).assertEqual('ok');
    });

    it('header_silently_drops_empty_name_and_null_value', 0, () => {
      const r = DMPWebSocketValidation.validateHeader({
        '   ': 'x',
        'Null-Value': null,
      });
      expect(r.ok).assertTrue();
      expect(r.value.size).assertEqual(0);
    });

    it('header_rejects_crlf_injection', 0, () => {
      const inName = DMPWebSocketValidation.validateHeader({ 'X-Evil\r\nInjected': 'v' });
      expect(inName.ok).assertFalse();
      expect(inName.errMsg).assertEqual('invalid header');

      const inValue = DMPWebSocketValidation.validateHeader({ 'X-Ok': 'v\r\nInjected: 1' });
      expect(inValue.ok).assertFalse();
      expect(inValue.errMsg).assertEqual('invalid header');
    });

    it('header_rejects_leading_trailing_crlf_before_trimming', 0, () => {
      // The CR/LF check must run on the raw (untrimmed) name, not the already-trimmed one,
      // otherwise a leading/trailing CR/LF is silently stripped away instead of being
      // rejected - matches Android/iOS, which both check the raw name.
      const r = DMPWebSocketValidation.validateHeader({ '\r\nX-Evil': 'v' });
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid header');
    });

    it('header_rejects_crlf_name_that_would_trim_to_empty', 0, () => {
      // The raw-name CR/LF check must run BEFORE the trim-to-empty/forbidden-name/null-value
      // early-continues, otherwise a name like "\r\n" (trims to empty) silently falls through
      // as "dropped" instead of failing invalid header.
      const r = DMPWebSocketValidation.validateHeader({ '\r\n': 'v' });
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid header');
    });

    it('header_rejects_crlf_name_that_would_trim_to_forbidden', 0, () => {
      const r = DMPWebSocketValidation.validateHeader({ 'Host\r\n': 'v' });
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid header');
    });

    it('header_rejects_crlf_name_paired_with_null_value', 0, () => {
      const r = DMPWebSocketValidation.validateHeader({ 'X-Evil\r\n': null });
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid header');
    });

    it('header_origin_injected_when_missing', 0, () => {
      const r = DMPWebSocketValidation.validateHeader({});
      expect(r.ok).assertTrue();
      DMPWebSocketValidation.injectOriginIfMissing(r.value, 'wss:', 'example.com');
      expect(r.value.get('Origin')).assertEqual('https://example.com');
    });

    it('header_origin_not_overridden_case_insensitively', 0, () => {
      const r = DMPWebSocketValidation.validateHeader({ 'origin': 'https://custom.example' });
      expect(r.ok).assertTrue();
      DMPWebSocketValidation.injectOriginIfMissing(r.value, 'wss:', 'example.com');
      expect(r.value.get('origin')).assertEqual('https://custom.example');
      expect(r.value.has('Origin')).assertFalse();
    });

    it('header_ws_scheme_injects_http_origin', 0, () => {
      const r = DMPWebSocketValidation.validateHeader({});
      DMPWebSocketValidation.injectOriginIfMissing(r.value, 'ws:', 'example.com:8080');
      expect(r.value.get('Origin')).assertEqual('http://example.com:8080');
    });

    it('header_origin_strips_explicit_default_port', 0, () => {
      // An explicitly-written default port (:80 for ws, :443 for wss) must be stripped from
      // the Origin header, matching Android's URI-based origin computation and the
      // dimina-kit `new URL(...).origin` ground truth - a non-default port must be kept.
      const ws = DMPWebSocketValidation.validateHeader({});
      DMPWebSocketValidation.injectOriginIfMissing(ws.value, 'ws:', 'example.com:80');
      expect(ws.value.get('Origin')).assertEqual('http://example.com');

      const wss = DMPWebSocketValidation.validateHeader({});
      DMPWebSocketValidation.injectOriginIfMissing(wss.value, 'wss:', 'example.com:443');
      expect(wss.value.get('Origin')).assertEqual('https://example.com');

      const nonDefault = DMPWebSocketValidation.validateHeader({});
      DMPWebSocketValidation.injectOriginIfMissing(nonDefault.value, 'wss:', 'example.com:80');
      // port 80 is not the default for wss, must be kept
      expect(nonDefault.value.get('Origin')).assertEqual('https://example.com:80');
    });

    // ---------------- close code ----------------
    it('close_code_default_when_missing', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode(undefined);
      expect(r.ok).assertTrue();
      expect(r.value).assertEqual(1000);
    });

    it('close_code_rejects_reserved_range', 0, () => {
      const cases = [999, 1001, 2999, 5000];
      for (let i = 0; i < cases.length; i++) {
        const r = DMPWebSocketValidation.validateCloseCode(cases[i]);
        expect(r.ok).assertFalse();
        expect(r.errMsg).assertEqual('invalid code');
      }
    });

    it('close_code_accepts_1000_and_3000_4999_range', 0, () => {
      const cases = [1000, 3000, 4999, 3500];
      for (let i = 0; i < cases.length; i++) {
        const r = DMPWebSocketValidation.validateCloseCode(cases[i]);
        expect(r.ok).assertTrue();
        expect(r.value).assertEqual(cases[i]);
      }
    });

    it('close_code_rejects_non_integer', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode(3000.5);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid code');
    });

    // ---------------- close reason ----------------
    it('close_reason_default_empty_when_missing', 0, () => {
      const r = DMPWebSocketValidation.validateCloseReason(undefined);
      expect(r.ok).assertTrue();
      expect(r.value).assertEqual('');
    });

    it('close_reason_rejects_non_string', 0, () => {
      const r = DMPWebSocketValidation.validateCloseReason(123);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('reason must be a string');
    });

    it('close_reason_rejects_over_123_utf8_bytes', 0, () => {
      const longAscii = new Array(124).fill('a').join('');
      const r = DMPWebSocketValidation.validateCloseReason(longAscii);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('reason must not exceed 123 UTF-8 bytes');
    });

    it('close_reason_accepts_up_to_123_utf8_bytes', 0, () => {
      const exact = new Array(123).fill('a').join('');
      const r = DMPWebSocketValidation.validateCloseReason(exact);
      expect(r.ok).assertTrue();
      expect(r.value).assertEqual(exact);
    });

    it('close_reason_counts_utf8_bytes_not_chars', 0, () => {
      // 41 个 3 字节 UTF-8 汉字 = 123 字节，应通过
      const cjk41 = new Array(41).fill('中').join('');
      const okResult = DMPWebSocketValidation.validateCloseReason(cjk41);
      expect(okResult.ok).assertTrue();

      // 42 个汉字 = 126 字节 > 123，应拒绝
      const cjk42 = new Array(42).fill('中').join('');
      const failResult = DMPWebSocketValidation.validateCloseReason(cjk42);
      expect(failResult.ok).assertFalse();
    });
  });
}
