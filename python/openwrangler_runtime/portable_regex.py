from __future__ import annotations

from dataclasses import dataclass

MAX_PORTABLE_REGEX_PATTERN_CODE_POINTS = 4_096
MAX_PORTABLE_REGEX_PATTERN_UTF8_BYTES = 16_384
MAX_PORTABLE_REGEX_CAPTURE_GROUPS = 9
MAX_PORTABLE_REGEX_REPEAT = 1_000
MAX_PORTABLE_REGEX_TEXT_CODE_POINTS = 8_192
MAX_PORTABLE_REGEX_TEXT_UTF8_BYTES = 8_192
MAX_PORTABLE_REGEX_OUTPUT_NAME_UTF8_BYTES = 1_024
PORTABLE_REGEX_TEXT_LIMIT_MESSAGE = (
    "Regex extraction source values must contain at most 8,192 Unicode scalar values and 8,192 UTF-8 bytes."
)

_ESCAPABLE = frozenset(r"\.[\](){ }*+?|^$-".replace(" ", ""))
_CLASS_ESCAPABLE = frozenset(("\\", "]", "-"))


class PortableRegexError(ValueError):
    """Raised when a public regex-extraction pattern is not portable."""


@dataclass(frozen=True, slots=True)
class PortableRegexContract:
    capture_count: int
    participation_pattern: str


@dataclass(slots=True)
class _RegexAtom:
    kind: str
    empty: bool
    nullable: bool
    quantified: bool
    minimum_width: int
    minimum_utf8_bytes: int
    group: int | None = None


@dataclass(slots=True)
class _OpenGroup:
    group: int
    atoms: list[_RegexAtom]


def validate_portable_regex_output_name(value: object) -> None:
    if not isinstance(value, str) or (
        value == ""
        or "\0" in value
        or "\r" in value
        or "\n" in value
        or any(0xD800 <= ord(character) <= 0xDFFF for character in value)
        or len(value.encode("utf-8")) > MAX_PORTABLE_REGEX_OUTPUT_NAME_UTF8_BYTES
    ):
        raise PortableRegexError(
            "Regex extraction output names must be non-empty single-line Unicode scalar text of at most "
            f"{MAX_PORTABLE_REGEX_OUTPUT_NAME_UTF8_BYTES:,} UTF-8 bytes."
        )


def portable_regex_contract(pattern: object, group: object) -> PortableRegexContract:
    if not isinstance(pattern, str) or (
        any(0xD800 <= ord(character) <= 0xDFFF for character in pattern)
        or "\0" in pattern
        or "\r" in pattern
        or "\n" in pattern
        or not 1 <= len(pattern) <= MAX_PORTABLE_REGEX_PATTERN_CODE_POINTS
        or len(pattern.encode("utf-8")) > MAX_PORTABLE_REGEX_PATTERN_UTF8_BYTES
    ):
        raise PortableRegexError(
            f"Regex extraction patterns must be single-line text containing 1 to "
            f"{MAX_PORTABLE_REGEX_PATTERN_CODE_POINTS:,} Unicode scalar "
            f"values and at most {MAX_PORTABLE_REGEX_PATTERN_UTF8_BYTES:,} UTF-8 bytes."
        )
    if isinstance(group, bool) or not isinstance(group, int) or not 0 <= group <= MAX_PORTABLE_REGEX_CAPTURE_GROUPS:
        raise PortableRegexError(
            f"Regex extraction group must be an integer from 0 to {MAX_PORTABLE_REGEX_CAPTURE_GROUPS}."
        )

    capture_count = 0
    open_group: _OpenGroup | None = None
    previous: _RegexAtom | None = None
    optional_group_markers: dict[int, int] = {}
    variable_width_quantifiers = 0
    minimum_required_width = 0
    minimum_required_utf8_bytes = 0

    def record_atom(atom: _RegexAtom) -> None:
        nonlocal previous, minimum_required_width, minimum_required_utf8_bytes
        previous = atom
        if open_group is not None:
            open_group.atoms.append(atom)
        else:
            minimum_required_width += atom.minimum_width
            minimum_required_utf8_bytes += atom.minimum_utf8_bytes

    index = 0
    while index < len(pattern):
        token = pattern[index]
        if token == "\\":
            if index + 1 >= len(pattern) or pattern[index + 1] not in _ESCAPABLE:
                raise PortableRegexError(
                    "Regex extraction permits escapes only for literal regular-expression punctuation."
                )
            index += 2
            record_atom(_RegexAtom("scalar", False, False, False, 1, 1))
            continue
        if token == "[":
            class_end, class_minimum_utf8_bytes = _consume_character_class(pattern, index)
            index = class_end + 1
            record_atom(_RegexAtom("scalar", False, False, False, 1, class_minimum_utf8_bytes))
            continue
        if token == "(":
            if open_group is not None:
                raise PortableRegexError("Regex extraction does not permit nested capture groups.")
            capture_count += 1
            if capture_count > MAX_PORTABLE_REGEX_CAPTURE_GROUPS:
                raise PortableRegexError(
                    f"Regex extraction permits at most {MAX_PORTABLE_REGEX_CAPTURE_GROUPS} capture groups."
                )
            open_group = _OpenGroup(capture_count, [])
            previous = None
            index += 1
            continue
        if token == ")":
            if open_group is None:
                raise PortableRegexError("Regex extraction contains an unmatched closing parenthesis.")
            previous = _RegexAtom(
                kind="group",
                group=open_group.group,
                empty=len(open_group.atoms) == 0,
                nullable=all(atom.nullable for atom in open_group.atoms),
                quantified=False,
                minimum_width=sum(atom.minimum_width for atom in open_group.atoms),
                minimum_utf8_bytes=sum(atom.minimum_utf8_bytes for atom in open_group.atoms),
            )
            open_group = None
            minimum_required_width += previous.minimum_width
            minimum_required_utf8_bytes += previous.minimum_utf8_bytes
            index += 1
            continue
        if token in "?*+{":
            if previous is None or previous.quantified:
                raise PortableRegexError("Regex extraction quantifiers must follow exactly one unquantified atom.")
            end = index
            variable_width = token in "?*+"
            minimum = 1 if token == "+" else 0
            if token == "{":
                end, minimum, maximum = _consume_bounded_quantifier(pattern, index)
                variable_width = minimum != maximum
            if previous.kind == "group" and token != "?":
                raise PortableRegexError("Regex extraction capture groups may use only the optional ? quantifier.")
            if previous.empty and token != "?":
                raise PortableRegexError("Regex extraction does not permit repeated empty atoms.")
            if previous.kind == "group" and token == "?" and previous.nullable:
                raise PortableRegexError("Regex extraction optional capture groups must not match an empty string.")
            if variable_width:
                variable_width_quantifiers += 1
                if variable_width_quantifiers > 1:
                    raise PortableRegexError(
                        "Regex extraction permits at most one variable-width quantifier per pattern."
                    )
            prior_minimum_width = previous.minimum_width
            prior_minimum_utf8_bytes = previous.minimum_utf8_bytes
            previous.quantified = True
            previous.nullable = token in "?*" or minimum == 0 or previous.nullable
            previous.minimum_width = prior_minimum_width * minimum
            previous.minimum_utf8_bytes = prior_minimum_utf8_bytes * minimum
            if open_group is None:
                minimum_required_width += previous.minimum_width - prior_minimum_width
                minimum_required_utf8_bytes += previous.minimum_utf8_bytes - prior_minimum_utf8_bytes
            if previous.kind == "group" and previous.group is not None:
                optional_group_markers[previous.group] = index
            index = end + 1
            continue
        if token in "]}|^$":
            raise PortableRegexError(f"Regex extraction does not permit unescaped {token!r}.")
        record_atom(_RegexAtom("scalar", False, False, False, 1, len(token.encode("utf-8"))))
        index += 1

    if open_group is not None:
        raise PortableRegexError("Regex extraction contains an unclosed capture group.")
    if (
        minimum_required_width > MAX_PORTABLE_REGEX_TEXT_CODE_POINTS
        or minimum_required_utf8_bytes > MAX_PORTABLE_REGEX_TEXT_UTF8_BYTES
    ):
        raise PortableRegexError(
            f"Regex extraction minimum match width must not exceed "
            f"{MAX_PORTABLE_REGEX_TEXT_CODE_POINTS:,} Unicode scalar values or "
            f"{MAX_PORTABLE_REGEX_TEXT_UTF8_BYTES:,} UTF-8 bytes."
        )
    if group > capture_count:
        raise PortableRegexError(f"Regex extraction group {group} does not exist; the pattern defines {capture_count}.")
    marker = optional_group_markers.get(group)
    return PortableRegexContract(
        capture_count=capture_count,
        participation_pattern=pattern if group == 0 or marker is None else pattern[:marker] + pattern[marker + 1 :],
    )


def _consume_character_class(pattern: str, start: int) -> tuple[int, int]:
    index = start + 1
    negated = index < len(pattern) and pattern[index] == "^"
    if negated:
        index += 1
    members = 0
    minimum_utf8_bytes = 1 if negated else MAX_PORTABLE_REGEX_TEXT_UTF8_BYTES + 1
    previous: str | None = None
    while index < len(pattern):
        token = pattern[index]
        escaped = False
        if token == "]":
            if members == 0:
                raise PortableRegexError("Regex extraction character classes must not be empty.")
            return index, minimum_utf8_bytes
        if token == "\\":
            if index + 1 >= len(pattern) or pattern[index + 1] not in _CLASS_ESCAPABLE:
                raise PortableRegexError("Regex extraction character classes permit escapes only for \\, ], and -.")
            index += 1
            token = pattern[index]
            escaped = True
        if token == "-" and not escaped:
            endpoint = pattern[index + 1] if index + 1 < len(pattern) else None
            if previous is None or endpoint in (None, "]", "\\"):
                raise PortableRegexError("Regex extraction character-class ranges require two literal endpoints.")
            if ord(previous) >= 128 or ord(endpoint) >= 128 or ord(previous) > ord(endpoint):
                raise PortableRegexError("Regex extraction character-class ranges must use ascending ASCII endpoints.")
            members += 1
            minimum_utf8_bytes = 1
            previous = endpoint
            index += 2
            continue
        members += 1
        minimum_utf8_bytes = min(minimum_utf8_bytes, len(token.encode("utf-8")))
        previous = token
        index += 1
    raise PortableRegexError("Regex extraction contains an unclosed character class.")


def _consume_bounded_quantifier(pattern: str, start: int) -> tuple[int, int, int]:
    close = pattern.find("}", start + 1)
    if close < 0:
        raise PortableRegexError("Regex extraction contains an unclosed bounded quantifier.")
    body = pattern[start + 1 : close]
    pieces = body.split(",")
    if len(pieces) not in (1, 2) or any(not item or not item.isascii() or not item.isdecimal() for item in pieces):
        raise PortableRegexError("Regex extraction bounded quantifiers must use {count} or {minimum,maximum}.")
    if any(len(item) > 1 and item.startswith("0") for item in pieces):
        raise PortableRegexError("Regex extraction bounded quantifiers must use {count} or {minimum,maximum}.")
    minimum = int(pieces[0])
    maximum = int(pieces[-1])
    if minimum > maximum or maximum > MAX_PORTABLE_REGEX_REPEAT:
        raise PortableRegexError(
            f"Regex extraction bounded quantifiers require 0 <= minimum <= maximum <= {MAX_PORTABLE_REGEX_REPEAT}."
        )
    return close, minimum, maximum
