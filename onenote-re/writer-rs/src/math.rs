//! Equations as OneNote's built-up math (`docs/file-format.md` §15.4): the
//! inverse of the importer's `buildDown` (`notecraft/src/model/importOne.ts`).
//!
//! OneNote's equation editor is RichEdit's math engine. A built-up math
//! object is the character U+FDD0, its arguments separated by U+FDEE, then
//! U+FDEF; objects nest inside arguments. The run holding the U+FDD0 carries
//! the object's `MathData_*` properties: `MathData_Type` (tom.h OBJECTTYPE),
//! `MathData_cArg`, and `MathData_Char` / `Char1` / `Char2` / `cCol` where the
//! type uses them. Every character of the equation has `MathFormatting`.
//!
//! The UnicodeMath linear form is parsed with the grammar of the Notecraft
//! engine's equation editor (`notecraft/crates/engine/src/math.rs`, ported
//! here because the engine depends on this crate). Arguments follow OMML's
//! order:
//!
//! | Linear | Type | Arguments |
//! |---|---|---|
//! | `x̂` (combining accent) | 10 accent, Char = the mark | base |
//! | `▭(…)` | 12 boxed formula | body |
//! | `(…)`, `[…]`, `|…|`, `⟨…⟩` | 13 brackets, Char / Char1 | body |
//! | `█(a@b)` | 15 equation array | one per row |
//! | `a/b` | 16 fraction | numerator, denominator |
//! | `sin x`, `sin^2 x`, `lim┬(n→∞) a_n` | 17 function apply | name, argument |
//! | `lim┬(n→∞)` | 19 lower limit | base, limit |
//! | `■(a&b@c&d)` | 20 matrix, cCol | cells row by row |
//! | `∑_(i=1)^n i` | 21 n-ary, Char = the operator | lower, upper, operand |
//! | `¯x` | 23 overbar | base |
//! | `⟡x` | 24 phantom | base |
//! | `√x`, `∛x`, `√(n&x)` | 25 radical | degree (empty for √), radicand |
//! | `n¦k` | 27 stack | top, bottom |
//! | `⏟x`, `⏞x` | 28 stretch stack, Char = the mark | base |
//! | `x_i`, `x_i^2`, `x^2` | 29, 30, 31 scripts | base, sub, sup |
//! | `▁x` | 32 underbar | base |
//! | `a┴b` | 33 upper limit | base, limit |
//!
//! An n-ary operator's operand and a function's argument are the item that
//! follows it. Everything else (operators, letters, numbers, quoted text,
//! unknown commands) stays plain math text, so an equation the grammar does
//! not cover is still written as its linear form.
//!
//! This module only uses `std`, so the tests can include it to check that
//! equations come back equivalent.

/// Structure characters.
pub(crate) const START: char = '\u{FDD0}';
pub(crate) const SEPARATOR: char = '\u{FDEE}';
pub(crate) const END: char = '\u{FDEF}';

/// tom.h OBJECTTYPE values.
pub(crate) mod kind {
    pub const ACCENT: u32 = 10;
    pub const BOXED_FORMULA: u32 = 12;
    pub const BRACKETS: u32 = 13;
    pub const EQUATION_ARRAY: u32 = 15;
    pub const FRACTION: u32 = 16;
    pub const FUNCTION_APPLY: u32 = 17;
    pub const LOWER_LIMIT: u32 = 19;
    pub const MATRIX: u32 = 20;
    pub const NARY: u32 = 21;
    pub const OVERBAR: u32 = 23;
    pub const PHANTOM: u32 = 24;
    pub const RADICAL: u32 = 25;
    pub const STACK: u32 = 27;
    pub const STRETCH_STACK: u32 = 28;
    pub const SUBSCRIPT: u32 = 29;
    pub const SUB_SUP: u32 = 30;
    pub const SUPERSCRIPT: u32 = 31;
    pub const UNDERBAR: u32 = 32;
    pub const UPPER_LIMIT: u32 = 33;
}

/// The `MathData_*` of one object.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct MathObject {
    pub kind: u32,
    pub args: u32,
    pub ch: Option<u16>,
    pub ch1: Option<u16>,
    pub ch2: Option<u16>,
    pub columns: Option<u8>,
}

impl MathObject {
    fn new(kind: u32, args: usize) -> MathObject {
        MathObject {
            kind,
            args: args as u32,
            ch: None,
            ch1: None,
            ch2: None,
            columns: None,
        }
    }
}

/// An equation's text, in order: math text (structure separators and ends
/// included) and object starts (each one U+FDD0 with its object).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum MathPiece {
    Text(String),
    Start(MathObject),
}

// --- the UnicodeMath grammar (notecraft/crates/engine/src/math.rs) ---------------

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Node {
    Ident(String),
    Num(String),
    Op(String),
    Text(String),
    Row(Vec<Node>),
    Frac(Box<Node>, Box<Node>),
    Sqrt(Box<Node>),
    /// Radicand, degree.
    Root(Box<Node>, Box<Node>),
    Sub(Box<Node>, Box<Node>),
    Sup(Box<Node>, Box<Node>),
    SubSup(Box<Node>, Box<Node>, Box<Node>),
    UnderOver(Box<Node>, Option<Box<Node>>, Option<Box<Node>>),
    Fenced(String, Box<Node>, String),
    Under(Box<Node>, Box<Node>),
    Over(Box<Node>, Box<Node>, bool),
    Table(Vec<Vec<Node>>),
    Stack(Box<Node>, Box<Node>),
    Boxed(Box<Node>),
    Phantom(Box<Node>),
}

fn accent_mark(c: char) -> Option<&'static str> {
    Some(match c {
        '\u{0300}' => "`",
        '\u{0301}' => "´",
        '\u{0302}' => "^",
        '\u{0303}' => "~",
        '\u{0304}' | '\u{0305}' => "¯",
        '\u{0306}' => "˘",
        '\u{0307}' => "˙",
        '\u{0308}' => "¨",
        '\u{030C}' => "ˇ",
        '\u{20D6}' => "←",
        '\u{20D7}' => "→",
        '\u{20E1}' => "↔",
        _ => return None,
    })
}

/// The combining character of an accent's spacing form.
fn combining(mark: &str) -> Option<char> {
    Some(match mark {
        "`" => '\u{0300}',
        "´" => '\u{0301}',
        "^" => '\u{0302}',
        "~" => '\u{0303}',
        "˘" => '\u{0306}',
        "˙" => '\u{0307}',
        "¨" => '\u{0308}',
        "ˇ" => '\u{030C}',
        "←" => '\u{20D6}',
        "→" => '\u{20D7}',
        "↔" => '\u{20E1}',
        _ => return None,
    })
}

const OVER_MARKS: &[char] = &['⏞', '⏜', '⎴'];
const UNDER_MARKS: &[char] = &['⏟', '⏝', '⎵'];
const NARY: &[char] = &['∑', '∏', '∐', '∫', '∬', '∭', '∮', '⋃', '⋂', '⋁', '⋀'];
const FUNCTIONS: &[&str] = &[
    "sin", "cos", "tan", "cot", "sec", "csc", "log", "ln", "exp", "lim", "max", "min", "det",
    "sinh", "cosh", "tanh", "arg", "gcd", "Pr",
];

fn keyword(name: &str) -> Option<&'static str> {
    Some(match name {
        "alpha" => "α",
        "beta" => "β",
        "gamma" => "γ",
        "delta" => "δ",
        "epsilon" => "ε",
        "zeta" => "ζ",
        "eta" => "η",
        "theta" => "θ",
        "iota" => "ι",
        "kappa" => "κ",
        "lambda" => "λ",
        "mu" => "μ",
        "nu" => "ν",
        "xi" => "ξ",
        "pi" => "π",
        "rho" => "ρ",
        "sigma" => "σ",
        "tau" => "τ",
        "upsilon" => "υ",
        "phi" => "φ",
        "chi" => "χ",
        "psi" => "ψ",
        "omega" => "ω",
        "Gamma" => "Γ",
        "Delta" => "Δ",
        "Theta" => "Θ",
        "Lambda" => "Λ",
        "Xi" => "Ξ",
        "Pi" => "Π",
        "Sigma" => "Σ",
        "Phi" => "Φ",
        "Psi" => "Ψ",
        "Omega" => "Ω",
        "sum" => "∑",
        "prod" => "∏",
        "int" => "∫",
        "iint" => "∬",
        "oint" => "∮",
        "infty" | "inf" => "∞",
        "partial" => "∂",
        "nabla" => "∇",
        "pm" => "±",
        "mp" => "∓",
        "times" => "×",
        "div" => "÷",
        "cdot" => "⋅",
        "le" | "leq" => "≤",
        "ge" | "geq" => "≥",
        "ne" | "neq" => "≠",
        "approx" => "≈",
        "equiv" => "≡",
        "to" | "rightarrow" => "→",
        "leftarrow" => "←",
        "Rightarrow" => "⇒",
        "in" => "∈",
        "notin" => "∉",
        "subset" => "⊂",
        "cup" => "∪",
        "cap" => "∩",
        "forall" => "∀",
        "exists" => "∃",
        "degree" => "°",
        "dots" | "ldots" => "…",
        "cdots" => "⋯",
        "sqrt" => "√",
        "cbrt" => "∛",
        _ => return None,
    })
}

struct Parser {
    chars: Vec<char>,
    i: usize,
    cells: usize,
    depth: usize,
}

/// Deeper nesting than this is read as plain text (no stack overflow on
/// hostile input, also in WebAssembly).
const MAX_DEPTH: usize = 64;

impl Parser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.i).copied()
    }

    fn skip_space(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.i += 1;
        }
    }

    fn word(&mut self) -> String {
        let start = self.i;
        while self.peek().is_some_and(|c| c.is_ascii_alphabetic()) {
            self.i += 1;
        }
        self.chars[start..self.i].iter().collect()
    }

    fn row(&mut self, close: Option<char>) -> Node {
        let mut items: Vec<Node> = Vec::new();
        let mut operand_start = 0;
        loop {
            let before = self.i;
            self.skip_space();
            if self.i > before {
                operand_start = items.len();
            }
            let Some(c) = self.peek() else { break };
            if Some(c) == close
                || ")]}⟩".contains(c) && close.is_some()
                || self.cells > 0 && (c == '&' || c == '@')
            {
                break;
            }
            if c == '\u{2061}' {
                self.i += 1;
                continue;
            }
            if let Some(mark) = accent_mark(c) {
                self.i += 1;
                let base = items.pop().unwrap_or(Node::Row(vec![]));
                items.push(Node::Over(
                    Box::new(base),
                    Box::new(Node::Op(mark.into())),
                    true,
                ));
                continue;
            }
            if c == '┬' || c == '┴' {
                self.i += 1;
                let base = items.pop().unwrap_or(Node::Row(vec![]));
                let limit = Box::new(strip_parens(self.operand()));
                items.push(if c == '┬' {
                    Node::Under(Box::new(base), limit)
                } else {
                    Node::Over(Box::new(base), limit, false)
                });
                continue;
            }
            if c == '¦' || c == '/' || c == '⁄' {
                self.i += 1;
                let mut tail = items.split_off(operand_start.min(items.len()));
                let top = if tail.len() == 1 {
                    tail.pop().unwrap_or(Node::Row(vec![]))
                } else {
                    Node::Row(tail)
                };
                let bottom = self.operand();
                operand_start = items.len();
                let (top, bottom) = (Box::new(strip_parens(top)), Box::new(strip_parens(bottom)));
                items.push(if c == '¦' {
                    Node::Stack(top, bottom)
                } else {
                    Node::Frac(top, bottom)
                });
                continue;
            }
            if c == '^' || c == '_' {
                self.i += 1;
                let base = items.pop().unwrap_or(Node::Row(vec![]));
                let script = strip_parens(self.atom());
                items.push(attach(base, c, script));
                continue;
            }
            let atom = self.atom();
            let is_op = matches!(atom, Node::Op(_) | Node::UnderOver(..));
            items.push(atom);
            if is_op {
                operand_start = items.len();
            }
        }
        if items.len() == 1 {
            items.pop().unwrap_or(Node::Row(vec![]))
        } else {
            Node::Row(items)
        }
    }

    fn operand(&mut self) -> Node {
        self.skip_space();
        let mut parts: Vec<Node> = Vec::new();
        while let Some(c) = self.peek() {
            if c.is_whitespace()
                || "/⁄¦┬┴&@".contains(c)
                || ")]}⟩".contains(c)
                || (c == '|' && !parts.is_empty())
            {
                break;
            }
            if let Some(mark) = accent_mark(c) {
                self.i += 1;
                let base = parts.pop().unwrap_or(Node::Row(vec![]));
                parts.push(Node::Over(
                    Box::new(base),
                    Box::new(Node::Op(mark.into())),
                    true,
                ));
                continue;
            }
            if c == '^' || c == '_' {
                self.i += 1;
                let base = parts.pop().unwrap_or(Node::Row(vec![]));
                let script = strip_parens(self.atom());
                parts.push(attach(base, c, script));
                continue;
            }
            let at = self.i;
            let atom = self.atom();
            if matches!(atom, Node::Op(_)) && !parts.is_empty() {
                self.i = at;
                break;
            }
            let lone_sign = matches!(atom, Node::Op(_));
            parts.push(atom);
            if self.i == at {
                break;
            }
            if lone_sign && self.peek().is_none_or(char::is_whitespace) {
                break;
            }
        }
        if parts.len() == 1 {
            parts.pop().unwrap_or(Node::Row(vec![]))
        } else {
            Node::Row(parts)
        }
    }

    fn atom(&mut self) -> Node {
        self.skip_space();
        let Some(c) = self.peek() else {
            return Node::Row(vec![]);
        };
        if self.depth >= MAX_DEPTH {
            self.i += 1;
            return Node::Op(c.to_string());
        }
        self.depth += 1;
        let node = self.atom_inner(c);
        self.depth -= 1;
        node
    }

    fn atom_inner(&mut self, c: char) -> Node {
        match c {
            '(' | '[' | '{' | '|' | '⟨' => {
                self.i += 1;
                let close = match c {
                    '(' => ')',
                    '[' => ']',
                    '{' => '}',
                    '⟨' => '⟩',
                    _ => '|',
                };
                let inner = self.row(Some(close));
                if self.peek() == Some(close) {
                    self.i += 1;
                }
                if c == '{' {
                    return Node::Row(vec![inner]);
                }
                Node::Fenced(c.to_string(), Box::new(inner), close.to_string())
            }
            '√' if self.chars.get(self.i + 1) == Some(&'(') => {
                self.i += 2;
                self.cells += 1;
                let first = self.row(Some(')'));
                let second = if self.peek() == Some('&') {
                    self.i += 1;
                    Some(self.row(Some(')')))
                } else {
                    None
                };
                self.cells -= 1;
                if self.peek() == Some(')') {
                    self.i += 1;
                }
                match second {
                    Some(radicand) => Node::Root(Box::new(radicand), Box::new(first)),
                    None => Node::Sqrt(Box::new(first)),
                }
            }
            '■' | '█' => {
                self.i += 1;
                self.skip_space();
                if self.peek() != Some('(') {
                    return Node::Op(c.to_string());
                }
                self.i += 1;
                self.cells += 1;
                let mut rows = vec![vec![]];
                loop {
                    let cell = self.row(Some(')'));
                    if let Some(r) = rows.last_mut() {
                        r.push(cell);
                    }
                    match self.peek() {
                        Some('&') => self.i += 1,
                        Some('@') => {
                            self.i += 1;
                            rows.push(vec![]);
                        }
                        Some(')') => {
                            self.i += 1;
                            break;
                        }
                        _ => break,
                    }
                }
                self.cells -= 1;
                Node::Table(rows)
            }
            '¯' | '▁' | '▭' | '□' | '⟡' => {
                self.i += 1;
                let x = Box::new(strip_parens(self.operand()));
                match c {
                    '¯' => Node::Over(x, Box::new(Node::Op("¯".into())), true),
                    '▁' => Node::Under(x, Box::new(Node::Op("_".into()))),
                    '▭' => Node::Boxed(x),
                    '⟡' => Node::Phantom(x),
                    _ => *x,
                }
            }
            c if OVER_MARKS.contains(&c) || UNDER_MARKS.contains(&c) => {
                self.i += 1;
                let x = Box::new(strip_parens(self.operand()));
                let mark = Box::new(Node::Op(c.to_string()));
                if OVER_MARKS.contains(&c) {
                    Node::Over(x, mark, false)
                } else {
                    Node::Under(x, mark)
                }
            }
            '√' | '∛' | '∜' => {
                self.i += 1;
                let radicand = strip_parens(self.operand());
                match c {
                    '√' => Node::Sqrt(Box::new(radicand)),
                    '∛' => Node::Root(Box::new(radicand), Box::new(Node::Num("3".into()))),
                    _ => Node::Root(Box::new(radicand), Box::new(Node::Num("4".into()))),
                }
            }
            '\\' => {
                self.i += 1;
                let name = self.word();
                match name.as_str() {
                    "frac" => {
                        let a = strip_parens(self.atom());
                        let b = strip_parens(self.atom());
                        Node::Frac(Box::new(a), Box::new(b))
                    }
                    "sqrt" => {
                        self.skip_space();
                        if self.peek() == Some('[') {
                            self.i += 1;
                            let index = self.row(Some(']'));
                            self.i += 1;
                            let r = strip_parens(self.atom());
                            return Node::Root(Box::new(r), Box::new(index));
                        }
                        Node::Sqrt(Box::new(strip_parens(self.atom())))
                    }
                    "text" | "mathrm" => {
                        let inner = strip_parens(self.atom());
                        Node::Text(plain(&inner))
                    }
                    "left" | "right" => self.atom(),
                    _ => match keyword(&name) {
                        Some(sym) if sym.chars().next().is_some_and(|ch| NARY.contains(&ch)) => {
                            self.nary(sym.chars().next().unwrap_or('∑'))
                        }
                        Some(sym) if sym.chars().all(char::is_alphabetic) => {
                            Node::Ident(sym.into())
                        }
                        Some(sym) => Node::Op(sym.into()),
                        None if FUNCTIONS.contains(&name.as_str()) => Node::Ident(name),
                        None => Node::Text(format!("\\{name}")),
                    },
                }
            }
            c if NARY.contains(&c) => {
                self.i += 1;
                self.nary(c)
            }
            c if c.is_ascii_digit() || c == '.' => {
                let start = self.i;
                while self.peek().is_some_and(|d| d.is_ascii_digit() || d == '.') {
                    self.i += 1;
                }
                Node::Num(self.chars[start..self.i].iter().collect())
            }
            c if c.is_ascii_alphabetic() => {
                let rest: String = self.chars[self.i..]
                    .iter()
                    .take_while(|ch| ch.is_ascii_alphabetic())
                    .collect();
                if let Some(f) = FUNCTIONS
                    .iter()
                    .filter(|f| rest.starts_with(**f))
                    .max_by_key(|f| f.len())
                {
                    self.i += f.len();
                    return Node::Ident(f.to_string());
                }
                self.i += 1;
                Node::Ident(c.to_string())
            }
            c if c.is_alphabetic() => {
                self.i += 1;
                Node::Ident(c.to_string())
            }
            '"' => {
                self.i += 1;
                let start = self.i;
                while self.peek().is_some_and(|ch| ch != '"') {
                    self.i += 1;
                }
                let t: String = self.chars[start..self.i].iter().collect();
                self.i += 1;
                Node::Text(t)
            }
            _ => {
                self.i += 1;
                Node::Op(match c {
                    '*' => "×".to_string(),
                    '-' => "−".to_string(),
                    _ => c.to_string(),
                })
            }
        }
    }

    fn nary(&mut self, op: char) -> Node {
        let (mut lower, mut upper) = (None, None);
        loop {
            self.skip_space();
            match self.peek() {
                Some('_') => {
                    self.i += 1;
                    lower = Some(Box::new(strip_parens(self.atom())));
                }
                Some('^') => {
                    self.i += 1;
                    upper = Some(Box::new(strip_parens(self.atom())));
                }
                _ => break,
            }
        }
        Node::UnderOver(Box::new(Node::Op(op.to_string())), lower, upper)
    }
}

/// A function name, possibly with scripts or a limit under it (`sin`,
/// `sin^2`, `log_2`, `lim┬(n→∞)`): RichEdit applies it to what follows.
fn is_function_name(n: &Node) -> bool {
    match n {
        Node::Ident(f) => FUNCTIONS.contains(&f.as_str()),
        Node::Sub(b, _) | Node::Sup(b, _) | Node::SubSup(b, _, _) | Node::Under(b, _) => {
            matches!(&**b, Node::Ident(f) if FUNCTIONS.contains(&f.as_str()))
        }
        _ => false,
    }
}

fn attach(base: Node, kind: char, script: Node) -> Node {
    match (kind, base) {
        ('^', Node::Sub(b, s)) => Node::SubSup(b, s, Box::new(script)),
        ('_', Node::Sup(b, s)) => Node::SubSup(b, Box::new(script), s),
        ('^', b) => Node::Sup(Box::new(b), Box::new(script)),
        (_, b) => Node::Sub(Box::new(b), Box::new(script)),
    }
}

fn strip_parens(n: Node) -> Node {
    match n {
        Node::Fenced(o, inner, _) if o == "(" => *inner,
        other => other,
    }
}

fn plain(n: &Node) -> String {
    match n {
        Node::Ident(s) | Node::Num(s) | Node::Op(s) | Node::Text(s) => s.clone(),
        Node::Row(v) => v.iter().map(plain).collect(),
        _ => String::new(),
    }
}

/// Parse an equation's linear form.
pub(crate) fn parse(linear: &str) -> Vec<Node> {
    let mut p = Parser {
        chars: linear.chars().collect(),
        i: 0,
        cells: 0,
        depth: 0,
    };
    let mut parts = Vec::new();
    while p.i < p.chars.len() {
        parts.push(p.row(None));
        if let Some(c) = p.peek() {
            p.i += 1;
            parts.push(Node::Op(c.to_string()));
        }
    }
    parts
}

// --- build-up ------------------------------------------------------------------------

/// What an argument holds.
enum Arg<'a> {
    Empty,
    Node(&'a Node),
    Text(&'a str),
}

#[derive(Default)]
struct Encoder {
    out: Vec<MathPiece>,
    /// The last plain token, to keep "1 2" from becoming "12".
    last: Option<Token>,
}

#[derive(Clone, Copy, PartialEq)]
enum Token {
    Num,
    Word,
    Other,
}

fn bmp(c: char) -> Option<u16> {
    u16::try_from(u32::from(c)).ok()
}

fn first_char(s: &str) -> Option<char> {
    let mut it = s.chars();
    let c = it.next()?;
    it.next().is_none().then_some(c)
}

impl Encoder {
    fn text(&mut self, s: &str, token: Token) {
        if s.is_empty() {
            return;
        }
        let space = matches!(
            (self.last, token),
            (Some(Token::Num), Token::Num) | (Some(Token::Word), Token::Word | Token::Num)
        );
        match self.out.last_mut() {
            Some(MathPiece::Text(t)) => {
                if space {
                    t.push(' ');
                }
                t.push_str(s);
            }
            _ => self.out.push(MathPiece::Text(s.to_string())),
        }
        self.last = Some(token);
    }

    fn structure(&mut self, c: char) {
        match self.out.last_mut() {
            Some(MathPiece::Text(t)) => t.push(c),
            _ => self.out.push(MathPiece::Text(c.to_string())),
        }
        self.last = None;
    }

    fn object(&mut self, obj: MathObject, args: &[Arg<'_>]) {
        self.out.push(MathPiece::Start(obj));
        self.last = None;
        for (k, a) in args.iter().enumerate() {
            if k > 0 {
                self.structure(SEPARATOR);
            }
            match a {
                Arg::Empty => {}
                Arg::Node(n) => self.node(n),
                Arg::Text(t) => self.text(t, Token::Word),
            }
            self.last = None;
        }
        self.structure(END);
    }

    fn opt<'a>(n: &'a Option<Box<Node>>) -> Arg<'a> {
        n.as_deref().map_or(Arg::Empty, Arg::Node)
    }

    /// Items in sequence; an n-ary operator takes the next item as its
    /// operand and a function name the next item as its argument.
    fn row(&mut self, items: &[Node]) {
        let mut i = 0;
        while i < items.len() {
            let next = items
                .get(i + 1)
                .filter(|n| !matches!(n, Node::Op(_) | Node::UnderOver(..)));
            match &items[i] {
                Node::UnderOver(op, lo, hi) => {
                    self.nary(op, lo, hi, next);
                    i += 1 + usize::from(next.is_some());
                }
                name if is_function_name(name) && next.is_some() => {
                    let name = match name {
                        Node::Ident(f) => Arg::Text(f),
                        other => Arg::Node(other),
                    };
                    let arg = next.map_or(Arg::Empty, Arg::Node);
                    self.object(MathObject::new(kind::FUNCTION_APPLY, 2), &[name, arg]);
                    i += 2;
                }
                n => {
                    self.node(n);
                    i += 1;
                }
            }
        }
    }

    fn nary(
        &mut self,
        op: &Node,
        lo: &Option<Box<Node>>,
        hi: &Option<Box<Node>>,
        body: Option<&Node>,
    ) {
        let mut obj = MathObject::new(kind::NARY, 3);
        if let Node::Op(s) = op {
            obj.ch = first_char(s).and_then(bmp);
        }
        let body = body.map_or(Arg::Empty, Arg::Node);
        self.object(obj, &[Self::opt(lo), Self::opt(hi), body]);
    }

    fn node(&mut self, n: &Node) {
        use Arg::Node as N;
        match n {
            Node::Ident(s) => {
                let token = if s.chars().count() > 1 {
                    Token::Word
                } else {
                    Token::Other
                };
                self.text(s, token);
            }
            Node::Num(s) => self.text(s, Token::Num),
            Node::Op(s) => self.text(s, Token::Other),
            Node::Text(s) if s.starts_with('\\') => self.text(s, Token::Other),
            Node::Text(s) => self.text(&format!("\"{s}\""), Token::Other),
            Node::Row(v) => self.row(v),
            Node::Frac(a, b) => self.object(MathObject::new(kind::FRACTION, 2), &[N(a), N(b)]),
            Node::Stack(a, b) => self.object(MathObject::new(kind::STACK, 2), &[N(a), N(b)]),
            Node::Sqrt(x) => self.object(MathObject::new(kind::RADICAL, 2), &[Arg::Empty, N(x)]),
            Node::Root(x, degree) => {
                self.object(MathObject::new(kind::RADICAL, 2), &[N(degree), N(x)])
            }
            Node::Sub(b, s) => self.object(MathObject::new(kind::SUBSCRIPT, 2), &[N(b), N(s)]),
            Node::Sup(b, s) => self.object(MathObject::new(kind::SUPERSCRIPT, 2), &[N(b), N(s)]),
            Node::SubSup(b, s, p) => {
                self.object(MathObject::new(kind::SUB_SUP, 3), &[N(b), N(s), N(p)])
            }
            Node::UnderOver(op, lo, hi) => self.nary(op, lo, hi, None),
            Node::Fenced(open, inner, close) => {
                let mut obj = MathObject::new(kind::BRACKETS, 1);
                obj.ch = first_char(open).and_then(bmp);
                obj.ch1 = first_char(close).and_then(bmp);
                self.object(obj, &[N(inner)]);
            }
            Node::Over(b, mark, true) => match &**mark {
                Node::Op(m) if m == "¯" => self.object(MathObject::new(kind::OVERBAR, 1), &[N(b)]),
                Node::Op(m) if combining(m).is_some() => {
                    let mut obj = MathObject::new(kind::ACCENT, 1);
                    obj.ch = combining(m).and_then(bmp);
                    self.object(obj, &[N(b)]);
                }
                other => self.object(MathObject::new(kind::UPPER_LIMIT, 2), &[N(b), N(other)]),
            },
            Node::Over(b, o, false) => match &**o {
                Node::Op(m) if first_char(m).is_some_and(|c| OVER_MARKS.contains(&c)) => {
                    let mut obj = MathObject::new(kind::STRETCH_STACK, 1);
                    obj.ch = first_char(m).and_then(bmp);
                    self.object(obj, &[N(b)]);
                }
                other => self.object(MathObject::new(kind::UPPER_LIMIT, 2), &[N(b), N(other)]),
            },
            Node::Under(b, u) => match &**u {
                Node::Op(m) if m == "_" => self.object(MathObject::new(kind::UNDERBAR, 1), &[N(b)]),
                Node::Op(m) if first_char(m).is_some_and(|c| UNDER_MARKS.contains(&c)) => {
                    let mut obj = MathObject::new(kind::STRETCH_STACK, 1);
                    obj.ch = first_char(m).and_then(bmp);
                    self.object(obj, &[N(b)]);
                }
                other => self.object(MathObject::new(kind::LOWER_LIMIT, 2), &[N(b), N(other)]),
            },
            Node::Table(rows) if rows.iter().all(|r| r.len() <= 1) => {
                let cells: Vec<Arg<'_>> = rows
                    .iter()
                    .map(|r| r.first().map_or(Arg::Empty, Arg::Node))
                    .collect();
                self.object(MathObject::new(kind::EQUATION_ARRAY, cells.len()), &cells);
            }
            Node::Table(rows) => {
                let cols = rows.iter().map(Vec::len).max().unwrap_or(1).min(255);
                let mut cells: Vec<Arg<'_>> = Vec::with_capacity(rows.len() * cols);
                for r in rows {
                    for c in 0..cols {
                        cells.push(r.get(c).map_or(Arg::Empty, Arg::Node));
                    }
                }
                let mut obj = MathObject::new(kind::MATRIX, cells.len());
                obj.columns = Some(cols as u8);
                self.object(obj, &cells);
            }
            Node::Boxed(x) => self.object(MathObject::new(kind::BOXED_FORMULA, 1), &[N(x)]),
            Node::Phantom(x) => self.object(MathObject::new(kind::PHANTOM, 1), &[N(x)]),
        }
    }
}

/// Build up an equation: its text with structure characters, and the object
/// at each U+FDD0. Characters that would read as structure (U+FDD0–U+FDEF)
/// and control characters are dropped from the input first.
pub(crate) fn build_up(linear: &str) -> Vec<MathPiece> {
    let clean: String = linear
        .chars()
        .filter(|c| !('\u{FDD0}'..='\u{FDEF}').contains(c))
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let mut e = Encoder::default();
    for part in parse(&clean) {
        e.node(&part);
    }
    e.out
}

/// Two equations that parse to the same tree, ignoring grouping: rows are
/// flattened, and parentheses that only group are dropped (around one
/// symbol, an n-ary operand or a function's argument).
#[cfg(test)]
pub(crate) fn equivalent(a: &str, b: &str) -> bool {
    sequence(Node::Row(parse(a))) == sequence(Node::Row(parse(b)))
}

#[cfg(test)]
fn flatten(n: Node, out: &mut Vec<Node>) {
    match n {
        Node::Row(v) => {
            for x in v {
                flatten(x, out);
            }
        }
        other => out.push(other),
    }
}

/// A node read as a sequence: flattened, each item normalized, grouping
/// parentheses after an n-ary operator or a function name dropped.
#[cfg(test)]
fn sequence(n: Node) -> Node {
    let mut items = Vec::new();
    flatten(n, &mut items);
    let mut out: Vec<Node> = Vec::with_capacity(items.len());
    for n in items.into_iter().map(normalize) {
        let groups = match out.last() {
            Some(Node::UnderOver(..)) => true,
            Some(f) => is_function_name(f),
            None => false,
        };
        match n {
            Node::Fenced(o, inner, _) if groups && o == "(" => flatten(*inner, &mut out),
            other => out.push(other),
        }
    }
    if out.len() == 1 {
        out.pop().unwrap_or(Node::Row(vec![]))
    } else {
        Node::Row(out)
    }
}

#[cfg(test)]
fn normalize(n: Node) -> Node {
    let s = |n: Box<Node>| Box::new(sequence(*n));
    match n {
        Node::Row(_) => sequence(n),
        Node::Frac(a, c) => Node::Frac(s(a), s(c)),
        Node::Stack(a, c) => Node::Stack(s(a), s(c)),
        Node::Sqrt(x) => Node::Sqrt(s(x)),
        Node::Root(x, d) => Node::Root(s(x), s(d)),
        Node::Sub(x, y) => Node::Sub(s(x), s(y)),
        Node::Sup(x, y) => Node::Sup(s(x), s(y)),
        Node::SubSup(x, y, z) => Node::SubSup(s(x), s(y), s(z)),
        Node::UnderOver(op, lo, hi) => Node::UnderOver(op, lo.map(s), hi.map(s)),
        // Parentheses around one symbol only group.
        Node::Fenced(o, inner, c) => match sequence(*inner) {
            single @ (Node::Ident(_) | Node::Num(_) | Node::Text(_)) if o == "(" => single,
            inner => Node::Fenced(o, Box::new(inner), c),
        },
        Node::Under(x, u) => Node::Under(s(x), s(u)),
        Node::Over(x, o, acc) => Node::Over(s(x), s(o), acc),
        Node::Table(rows) => Node::Table(
            rows.into_iter()
                .map(|r| r.into_iter().map(sequence).collect())
                .collect(),
        ),
        Node::Boxed(x) => Node::Boxed(s(x)),
        Node::Phantom(x) => Node::Phantom(s(x)),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(linear: &str) -> String {
        build_up(linear)
            .iter()
            .map(|p| match p {
                MathPiece::Text(t) => t.replace(SEPARATOR, "|").replace(END, "]"),
                MathPiece::Start(o) => format!("[{}:", o.kind),
            })
            .collect()
    }

    #[test]
    fn objects_nest_with_their_arguments() {
        assert_eq!(shape("a/b"), "[16:a|b]");
        assert_eq!(shape("x^2"), "[31:x|2]");
        assert_eq!(shape("x_i^2"), "[30:x|i|2]");
        assert_eq!(
            shape("x=(-b±√(b^2-4ac))/2a"),
            "x=[16:−b±[25:|[31:b|2]−4ac]|2a]"
        );
        assert_eq!(shape("∑_(i=1)^n i^2"), "[21:i=1|n|[31:i|2]]");
        assert_eq!(shape("sin x"), "[17:sin|x]");
        assert_eq!(shape("sin^2 x"), "[17:[31:sin|2]|x]");
        assert_eq!(shape("lim┬(n→∞) a_n"), "[17:[19:lim|n→∞]|[29:a|n]]");
        assert_eq!(shape("■(a&b@c)"), "[20:a|b|c|]");
        assert_eq!(shape("█(x@y)"), "[15:x|y]");
        assert_eq!(shape("(a+b)"), "[13:a+b]");
        assert_eq!(shape("x\u{0302}"), "[10:x]");
        assert_eq!(shape("1 2"), "1 2");
        assert_eq!(shape("\"speed\"=d/t"), "\"speed\"=[16:d|t]");
    }

    #[test]
    fn object_characters() {
        let objs: Vec<MathObject> = build_up("∫_0^1 ⏟(a+b) [x] ■(1&0@0&1) x\u{0307}")
            .into_iter()
            .filter_map(|p| match p {
                MathPiece::Start(o) => Some(o),
                MathPiece::Text(_) => None,
            })
            .collect();
        assert_eq!(objs[0].ch, Some('∫' as u16));
        assert_eq!(objs[1].kind, kind::STRETCH_STACK);
        assert_eq!(objs[1].ch, Some('⏟' as u16));
        let brackets = objs
            .iter()
            .find(|o| o.kind == kind::BRACKETS && o.ch == Some('[' as u16))
            .unwrap();
        assert_eq!(brackets.ch1, Some(']' as u16));
        let matrix = objs.iter().find(|o| o.kind == kind::MATRIX).unwrap();
        assert_eq!((matrix.args, matrix.columns), (4, Some(2)));
        let accent = objs.iter().find(|o| o.kind == kind::ACCENT).unwrap();
        assert_eq!(accent.ch, Some(0x0307));
    }

    #[test]
    fn structure_characters_in_the_input_are_dropped() {
        assert_eq!(shape("a\u{FDD0}b\u{FDEF}"), "ab");
    }

    #[test]
    fn never_panics_on_odd_input() {
        let deep = "(".repeat(5000) + &"√".repeat(5000);
        for s in [
            "", "/", "^", "))", "(((", "\\", "\\frac", "a/", "∑", "√", "\"open", "x__y^^z", "■(",
            "■(a&", "█(@@", "√(&", "√(3&", "┬", "a┴", "¯", "\u{0302}", "&@", "■", "⏟", "¦", &deep,
        ] {
            let _ = build_up(s);
        }
    }

    #[test]
    fn equivalence_ignores_grouping_only() {
        assert!(equivalent("∫_0^1 f(x)dx", "∫_0^1 f(x)dx"));
        assert!(equivalent("∑_k a_k", "∑_k (a_k)"));
        assert!(equivalent("\\frac{1}{2}", "1/2"));
        assert!(!equivalent("(a+b)c", "a+bc"));
        assert!(!equivalent("a/b", "b/a"));
    }
}
