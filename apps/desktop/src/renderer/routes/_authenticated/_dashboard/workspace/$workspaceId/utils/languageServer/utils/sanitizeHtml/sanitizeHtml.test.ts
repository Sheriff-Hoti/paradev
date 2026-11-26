import { describe, expect, test } from "bun:test";
import { sanitizeHtml } from "./sanitizeHtml";

describe("sanitizeHtml", () => {
	test("keeps doc markup and strips scripts, handlers and unsafe links", () => {
		const html = sanitizeHtml(
			[
				'<p onclick="x()">Returns <code class="tok">string</code></p>',
				"<script>alert(1)</script>",
				'<img src="x" onerror="alert(1)">',
				'<a href="javascript:alert(1)">bad</a>',
				'<a href="https://example.com" target="_blank">good</a>',
				"<custom-tag><em>kept text</em></custom-tag>",
			].join(""),
		);
		expect(html).toBe(
			'<p>Returns <code class="tok">string</code></p>' +
				"<a>bad</a>" +
				'<a href="https://example.com">good</a>' +
				"<em>kept text</em>",
		);
	});
});
