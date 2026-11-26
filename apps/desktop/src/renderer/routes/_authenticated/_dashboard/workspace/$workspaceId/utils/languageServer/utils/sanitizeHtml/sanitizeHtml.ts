const ALLOWED_TAGS = new Set([
	"A",
	"B",
	"BLOCKQUOTE",
	"BR",
	"CODE",
	"DIV",
	"EM",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"HR",
	"I",
	"LI",
	"OL",
	"P",
	"PRE",
	"SPAN",
	"STRONG",
	"TABLE",
	"TBODY",
	"TD",
	"TH",
	"THEAD",
	"TR",
	"UL",
]);

const DROPPED_WITH_CONTENT = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT"]);

/** Keeps the markup hover docs need; drops every other tag and attribute. */
export function sanitizeHtml(html: string): string {
	const document = new DOMParser().parseFromString(
		`<body>${html}</body>`,
		"text/html",
	);
	clean(document.body);
	return document.body.innerHTML;
}

function clean(parent: Element) {
	for (const node of [...parent.childNodes]) {
		if (node.nodeType === Node.TEXT_NODE) continue;
		if (node.nodeType !== Node.ELEMENT_NODE) {
			node.remove();
			continue;
		}
		const element = node as Element;
		if (DROPPED_WITH_CONTENT.has(element.tagName)) {
			element.remove();
			continue;
		}
		clean(element);
		if (!ALLOWED_TAGS.has(element.tagName)) {
			element.replaceWith(...element.childNodes);
			continue;
		}
		for (const { name } of [...element.attributes]) {
			if (!isAllowedAttribute(element, name)) element.removeAttribute(name);
		}
	}
}

function isAllowedAttribute(element: Element, name: string): boolean {
	if (name === "class")
		return element.tagName === "SPAN" || element.tagName === "CODE";
	if (name === "href" && element.tagName === "A") {
		return /^https?:\/\//i.test(element.getAttribute("href") ?? "");
	}
	return false;
}
