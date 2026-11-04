// ==========================================
// FEATURE SELECTION RULES (Owner Portal; pure)
//
// The checklist in the Owner Portal never enables or disables a module behind the Owner's back. Turning a module ON that
// needs another one, or turning one OFF that others depend on, is REFUSED with an explanation and an explicit action
// ("Enable both" / "Disable all"), so the Owner always sees and confirms the whole effect.
//
// `catalog`: [{ id, name, requires: [ids] }] as served by GET /api/platform/companies/features/catalog.
// `selected`: the current list of enabled ids.
// Every function returns { selected, notice } -- `notice` is null on success, otherwise
// { message, action: { label, selected } } where `action.selected` is the list that results if the Owner accepts.
// ==========================================

const nameOf = (catalog, id) => catalog.find((feature) => feature.id === id)?.name || id;
const join = (catalog, ids) => {
  const names = ids.map((id) => nameOf(catalog, id));
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};
const inCatalogOrder = (catalog, ids) => catalog.map((feature) => feature.id).filter((id) => ids.includes(id));

export function unmetRequirements(catalog, selected, id) {
  const feature = catalog.find((entry) => entry.id === id);
  return (feature?.requires || []).filter((required) => !selected.includes(required));
}

export function dependentsInSelection(catalog, selected, id) {
  return catalog.filter((entry) => selected.includes(entry.id) && entry.requires.includes(id)).map((entry) => entry.id);
}

export function toggleFeature(catalog, selected, id) {
  if (selected.includes(id)) {
    const dependents = dependentsInSelection(catalog, selected, id);
    if (dependents.length > 0) {
      return {
        selected,
        notice: {
          message: `${join(catalog, dependents)} ${dependents.length === 1 ? "needs" : "need"} ${nameOf(catalog, id)}, so ${nameOf(catalog, id)} cannot be turned off on its own.`,
          action: {
            label: `Turn off ${join(catalog, [id, ...dependents])}`,
            selected: inCatalogOrder(catalog, selected.filter((entry) => entry !== id && !dependents.includes(entry))),
          },
        },
      };
    }
    return { selected: selected.filter((entry) => entry !== id), notice: null };
  }

  const needed = unmetRequirements(catalog, selected, id);
  if (needed.length > 0) {
    return {
      selected,
      notice: {
        message: `${nameOf(catalog, id)} requires ${join(catalog, needed)}, which ${needed.length === 1 ? "is" : "are"} not selected.`,
        action: { label: `Turn on ${join(catalog, [...needed, id])}`, selected: inCatalogOrder(catalog, [...selected, ...needed, id]) },
      },
    };
  }
  return { selected: inCatalogOrder(catalog, [...selected, id]), notice: null };
}

export const selectAll = (catalog) => catalog.map((feature) => feature.id);
export const deselectAll = () => [];
