import { describe, expect, test } from "bun:test";
import { HIDDEN_PRO_SETTINGS_SECTIONS } from "renderer/components/Paywall/hiddenProUi";
import type { SettingsSection } from "renderer/stores/settings-state";
import {
	isSettingsSectionVisible,
	SETTINGS_SECTION_GROUPS,
	type SettingsSectionVisibility,
} from "./settingsSections";

const items = SETTINGS_SECTION_GROUPS.flatMap((group) => group.items);
const allSections = new Set<SettingsSection>(items.map((item) => item.section));

function visibleSections(overrides: Partial<SettingsSectionVisibility>) {
	const visibility: SettingsSectionVisibility = {
		isMac: true,
		isAdmin: true,
		pluginsEnabled: true,
		cloudUsageEnabled: true,
		allowedSections: allSections,
		...overrides,
	};
	return items
		.filter((item) => isSettingsSectionVisible(item, visibility))
		.map((item) => item.section);
}

describe("isSettingsSectionVisible", () => {
	test("hides a section by platform, role, flag and app variant", () => {
		expect(visibleSections({})).toHaveLength(
			items.length - HIDDEN_PRO_SETTINGS_SECTIONS.size,
		);
		for (const section of HIDDEN_PRO_SETTINGS_SECTIONS) {
			expect(visibleSections({})).not.toContain(section);
		}
		expect(visibleSections({ isMac: false })).not.toContain("permissions");
		expect(visibleSections({ isAdmin: false })).not.toContain("plugins");
		expect(visibleSections({ pluginsEnabled: false })).not.toContain("plugins");
		expect(visibleSections({ cloudUsageEnabled: false })).not.toContain(
			"cloudUsage",
		);
		expect(
			visibleSections({
				allowedSections: new Set<SettingsSection>(["account", "billing"]),
			}),
		).toEqual(["account"]);
	});
});
