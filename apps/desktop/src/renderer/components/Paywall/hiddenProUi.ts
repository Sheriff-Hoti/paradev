import type { SettingsSection } from "renderer/stores/settings-state";

export const HIDE_PRO_UI = true;

export const HIDDEN_PRO_SETTINGS_SECTIONS: ReadonlySet<SettingsSection> =
	new Set<SettingsSection>(
		HIDE_PRO_UI ? ["billing", "mobile", "security", "environments"] : [],
	);
