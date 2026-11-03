// A binding is affected when the assigned path overlaps a dependency.
export function propertyBindingPaths(binding) {
	if (binding?.dependencyPaths) return binding.dependencyPaths
	const expression = binding?.expression
	if (typeof expression === 'string' && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/.test(expression)) {
		return [expression.match(/[\w$]+/g)]
	}
	return []
}

export function propertyBindingPathMatches(dependency, assignment) {
	const length = Math.min(dependency.length, assignment.length)
	for (let i = 0; i < length; i++) {
		if (dependency[i] !== assignment[i] && String(dependency[i]) !== String(assignment[i])) return false
	}
	return length > 0
}
