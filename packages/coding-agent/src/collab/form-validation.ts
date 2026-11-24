import { choiceValue, fieldError, textValue, type HtmlFormData } from "@oh-my-pi/pi-tui/html-form/data";
import type { HtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";

/** Validate every field and reconstruct the data returned by the form. */
export function validateFormData(form: HtmlForm, submitted: unknown): HtmlFormData {
	if (typeof submitted !== "object" || submitted === null || Array.isArray(submitted))
		throw new Error("Form response must carry field states");
	const input = submitted as Record<string, unknown>;
	if (Object.keys(input).length !== 1 || !Array.isArray(input.fields) || input.fields.length !== form.fields.length)
		throw new Error("Form response must carry one state per field");
	const data: HtmlFormData = Object.assign(Object.create(null), Object.fromEntries(form.hidden));
	for (const [index, field] of form.fields.entries()) {
		const state: unknown = input.fields[index];
		let value;
		if (field.kind === "text") {
			if (typeof state !== "string") throw new Error(`Invalid value for ${JSON.stringify(field.name)}`);
			value = textValue(field, state);
		} else {
			if (typeof state !== "object" || state === null || Array.isArray(state))
				throw new Error(`Invalid choice for ${JSON.stringify(field.name)}`);
			const choice = state as Record<string, unknown>;
			if (Object.keys(choice).some(key => key !== "checked" && key !== "other") || !Array.isArray(choice.checked))
				throw new Error(`Invalid choice for ${JSON.stringify(field.name)}`);
			const checked = new Set<number>();
			for (const selected of choice.checked) {
				if (
					typeof selected !== "number" ||
					!Number.isInteger(selected) ||
					selected < 0 ||
					selected >= field.options.length ||
					checked.has(selected) ||
					field.options[selected]!.disabled
				)
					throw new Error(`Invalid option for ${JSON.stringify(field.name)}`);
				checked.add(selected);
			}
			if (
				(!field.multi && checked.size > 1) ||
				(choice.other !== undefined && (typeof choice.other !== "string" || !field.other))
			)
				throw new Error(`Invalid choice for ${JSON.stringify(field.name)}`);
			const other = typeof choice.other === "string" ? choice.other.trim() : undefined;
			if (
				other &&
				!field.options.some(option => !option.disabled && option.value === other) &&
				field.options.some(option => option.disabled && option.value === other)
			)
				throw new Error(`Disabled option for ${JSON.stringify(field.name)}`);
			if (!field.multi && other && checked.size) throw new Error(`Invalid choice for ${JSON.stringify(field.name)}`);
			value = choiceValue(field, checked, other);
		}
		const error = fieldError(field, value);
		if (error) throw new Error(`Form field ${JSON.stringify(field.name)}: ${error}`);
		if (field.name && value !== undefined) data[field.name] = value;
	}
	return data;
}
