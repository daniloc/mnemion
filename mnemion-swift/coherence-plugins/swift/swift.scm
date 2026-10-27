; Swift's imports and top-level declarations, as the capture names Coherence reads (docs/plugins.md).
; The parser beside it, tree-sitter-swift.wasm, is the one tree-sitter-swift 0.7.3 attaches to its GitHub release, copied as is (language ABI 15).

; import Foundation, @testable import MnemionKit, @_exported import Shared -- the whole module.
; import struct Foundation.Date, import Foundation.NSString -- a member or submodule of a module: the module is the first path element, and
; Swift narrows what the file sees to that member but renames nothing, so it is read as the module whole.
(import_declaration (identifier . (simple_identifier) @import.module)) @import

; a struct, class, actor or enum declares a body (its methods are its own); an extension adds to a type declared elsewhere and declares no name.
; public, open or package puts a declaration in the module's interface; every other modifier (or none) keeps it inside the module.
; Of each pair below the exported pattern comes first: a declaration matches both, and the reading keeps the first match of a name on a line.
((source_file (class_declaration (modifiers (visibility_modifier) @_v) declaration_kind: _ @_kind name: (type_identifier) @name) @declaration.body @exported) (#not-eq? @_kind "extension") (#match? @_v "^(?:public|open|package)$"))
((source_file (class_declaration declaration_kind: _ @_kind name: (type_identifier) @name) @declaration.body) (#not-eq? @_kind "extension"))

; a protocol or a typealias declares a type
((source_file (protocol_declaration (modifiers (visibility_modifier) @_v) name: (type_identifier) @name) @declaration.type @exported) (#match? @_v "^(?:public|open|package)$"))
(source_file (protocol_declaration name: (type_identifier) @name) @declaration.type)
((source_file (typealias_declaration (modifiers (visibility_modifier) @_v) name: (type_identifier) @name) @declaration.type @exported) (#match? @_v "^(?:public|open|package)$"))
(source_file (typealias_declaration name: (type_identifier) @name) @declaration.type)

; a free func declares a body
((source_file (function_declaration (modifiers (visibility_modifier) @_v) name: (simple_identifier) @name) @declaration.body @exported) (#match? @_v "^(?:public|open|package)$"))
(source_file (function_declaration name: (simple_identifier) @name) @declaration.body)

; a let or var at the top level is read by what it holds: a literal (an array, dictionary or tuple of them, an operator's result) is a value;
; a closure or a computed property is a body; anything else (a call's result, a name, nothing at all) may hold code, so it is counted as able to execute
((source_file (property_declaration (modifiers (visibility_modifier) @_v) name: (pattern bound_identifier: (simple_identifier) @name) value: [(integer_literal) (real_literal) (hex_literal) (oct_literal) (bin_literal) (line_string_literal) (multi_line_string_literal) (raw_string_literal) (boolean_literal) (array_literal) (dictionary_literal) (tuple_expression) (prefix_expression) (additive_expression) (multiplicative_expression)]) @declaration.value @exported) (#match? @_v "^(?:public|open|package)$"))
(source_file (property_declaration name: (pattern bound_identifier: (simple_identifier) @name) value: [(integer_literal) (real_literal) (hex_literal) (oct_literal) (bin_literal) (line_string_literal) (multi_line_string_literal) (raw_string_literal) (boolean_literal) (array_literal) (dictionary_literal) (tuple_expression) (prefix_expression) (additive_expression) (multiplicative_expression)]) @declaration.value)
((source_file (property_declaration (modifiers (visibility_modifier) @_v) name: (pattern bound_identifier: (simple_identifier) @name) value: (lambda_literal)) @declaration.body @exported) (#match? @_v "^(?:public|open|package)$"))
(source_file (property_declaration name: (pattern bound_identifier: (simple_identifier) @name) value: (lambda_literal)) @declaration.body)
((source_file (property_declaration (modifiers (visibility_modifier) @_v) name: (pattern bound_identifier: (simple_identifier) @name) computed_value: (computed_property)) @declaration.body @exported) (#match? @_v "^(?:public|open|package)$"))
(source_file (property_declaration name: (pattern bound_identifier: (simple_identifier) @name) computed_value: (computed_property)) @declaration.body)
((source_file (property_declaration (modifiers (visibility_modifier) @_v) name: (pattern bound_identifier: (simple_identifier) @name) value: [(call_expression) (simple_identifier) (navigation_expression) (ternary_expression) (await_expression) (try_expression) (as_expression) (nil_coalescing_expression) (comparison_expression) (conjunction_expression) (disjunction_expression) (equality_expression) (range_expression) (postfix_expression) (constructor_expression) (open_start_range_expression) (open_end_range_expression) (bitwise_operation) (infix_expression) (selector_expression) (key_path_expression) (key_path_string_expression) (super_expression) (self_expression)]) @declaration.unknown @exported) (#match? @_v "^(?:public|open|package)$"))
(source_file (property_declaration name: (pattern bound_identifier: (simple_identifier) @name) value: [(call_expression) (simple_identifier) (navigation_expression) (ternary_expression) (await_expression) (try_expression) (as_expression) (nil_coalescing_expression) (comparison_expression) (conjunction_expression) (disjunction_expression) (equality_expression) (range_expression) (postfix_expression) (constructor_expression) (open_start_range_expression) (open_end_range_expression) (bitwise_operation) (infix_expression) (selector_expression) (key_path_expression) (key_path_string_expression) (super_expression) (self_expression)]) @declaration.unknown)
((source_file (property_declaration (modifiers (visibility_modifier) @_v) name: (pattern bound_identifier: (simple_identifier) @name) !value !computed_value) @declaration.unknown @exported) (#match? @_v "^(?:public|open|package)$"))
(source_file (property_declaration name: (pattern bound_identifier: (simple_identifier) @name) !value !computed_value) @declaration.unknown)

; let (a, b) = ... binds the names its tuple pattern spells; the first is read as the declaration's name
(source_file (property_declaration name: (pattern . (pattern (simple_identifier) @name)) value: (_)) @declaration.unknown)
