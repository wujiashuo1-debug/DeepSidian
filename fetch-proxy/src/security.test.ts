import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateIPv4, isPrivateIPv6, isPrivateAddress, parseAndValidateUrl } from "./security";

test("blocks private / loopback IPv4 ranges", () => {
  const privateIps = [
    "127.0.0.1",
    "127.255.255.255",
    "10.0.0.5",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "192.168.255.255",
    "169.254.1.1",
    "0.0.0.0"
  ];

  for (const ip of privateIps) {
    assert.equal(isPrivateIPv4(ip), true, `${ip} should be private`);
  }
});

test("allows public IPv4 (incl. 172.x boundary cases)", () => {
  const publicIps = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "11.0.0.1", // just outside 10/8
    "172.15.255.255", // just below 172.16
    "172.32.0.1" // just above 172.31
  ];

  for (const ip of publicIps) {
    assert.equal(isPrivateIPv4(ip), false, `${ip} should be public`);
  }
});

test("blocks private / loopback IPv6", () => {
  for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPrivateIPv6(ip), true, `${ip} should be private`);
  }
});

test("allows public IPv6 and maps ipv4-mapped public", () => {
  assert.equal(isPrivateIPv6("2001:4860:4860::8888"), false);
  assert.equal(isPrivateIPv6("::ffff:8.8.8.8"), false);
});

test("isPrivateAddress handles brackets and non-IP hosts", () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("[::1]"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("example.com"), false); // domains are not literal IPs
});

test("parseAndValidateUrl rejects non-http(s) and malformed URLs", () => {
  assert.throws(() => parseAndValidateUrl("file:///etc/passwd"));
  assert.throws(() => parseAndValidateUrl("ftp://example.com"));
  assert.throws(() => parseAndValidateUrl("javascript:alert(1)"));
  assert.throws(() => parseAndValidateUrl("not a url"));
  assert.equal(parseAndValidateUrl("https://example.com").protocol, "https:");
  assert.equal(parseAndValidateUrl("http://example.com").protocol, "http:");
});
