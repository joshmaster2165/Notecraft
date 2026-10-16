//! Insert › Equation: UnicodeMath linear format → MathML.
//!
//! OneNote's equation editor is RichEdit's math engine. You type the linear
//! form (`x=(-b±√(b^2-4ac))/2a`) and it "builds up" a 2D equation; in the
//! file, math text runs carry `MathFormatting` (0x08003401) and each math
//! object (fraction, radical, n-ary, script, delimiter…) is described by the
//! `MathData_*` properties (`MathData_Type` 0x1400344F, `MathData_cArg`,
//! `MathData_Char`…). This module implements the build-up for the common
//! subset, emitting MathML that the web view renders and Office Math (OMML)
//! for Word, and also accepts the LaTeX commands people often type (`\frac`,
//! `\sqrt`, `\alpha`…). Beyond fractions, scripts, radicals and n-ary
//! operators it reads the constructs equations imported from OneNote come
//! back as: `■(a&b@c&d)` matrices, `█(a@b)` equation arrays, `√(n&x)`, `a┬b`
//! / `a┴b` limits, `¯x` / `▁x` bars, `▭x` boxes, `⟡x` phantoms, `a¦b` stacks,
//! combining accents (`x̂`) and stretched braces (`⏟x`).

#[derive(Debug, Clone, PartialEq)]
enum Node {
    Ident(String),
    Num(String),
    Op(String),
    Text(String),
    Row(Vec<Node>),
    Frac(Box<Node>, Box<Node>),
    Sqrt(Box<Node>),
    Root(Box<Node>, Box<Node>),
    Sub(Box<Node>, Box<Node>),
    Sup(Box<Node>, Box<Node>),
    SubSup(Box<Node>, Box<Node>, Box<Node>),
    UnderOver(Box<Node>, Option<Box<Node>>, Option<Box<Node>>),
    Fenced(String, Box<Node>, String),
    /// A base with something under it (`a┬b`, `▁x`, `⏟x`) or over it (`a┴b`, `¯x`, `x̂`).
    Under(Box<Node>, Box<Node>),
    Over(Box<Node>, Box<Node>, bool),
    /// `■(…)` matrix or `█(…)` equation array: rows of cells.
    Table(Vec<Vec<Node>>),
    /// `a¦b`: a fraction without its bar.
    Stack(Box<Node>, Box<Node>),
    /// `▭x`: a boxed formula.
    Boxed(Box<Node>),
    /// `⟡x`: takes up room, draws nothing.
    Phantom(Box<Node>),
}

/// Spacing forms for combining accents, for MathML's `<mo>`.
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

const OVER_MARKS: &[char] = &['⏞', '⏜', '⎴'];
const UNDER_MARKS: &[char] = &['⏟', '⏝', '⎵'];

const NARY: &[char] = &['∑', '∏', '∐', '∫', '∬', '∭', '∮', '⋃', '⋂', '⋁', '⋀'];
const FUNCTIONS: &[&str] = &["sin", "cos", "tan", "cot", "sec", "csc", "log", "ln", "exp", "lim", "max", "min", "det", "sinh", "cosh", "tanh", "arg", "gcd", "Pr"];

fn keyword(name: &str) -> Option<&'static str> {
    Some(match name {
        "alpha" => "α", "beta" => "β", "gamma" => "γ", "delta" => "δ", "epsilon" => "ε", "zeta" => "ζ", "eta" => "η", "theta" => "θ",
        "iota" => "ι", "kappa" => "κ", "lambda" => "λ", "mu" => "μ", "nu" => "ν", "xi" => "ξ", "pi" => "π", "rho" => "ρ", "sigma" => "σ",
        "tau" => "τ", "upsilon" => "υ", "phi" => "φ", "chi" => "χ", "psi" => "ψ", "omega" => "ω",
        "Gamma" => "Γ", "Delta" => "Δ", "Theta" => "Θ", "Lambda" => "Λ", "Xi" => "Ξ", "Pi" => "Π", "Sigma" => "Σ", "Phi" => "Φ", "Psi" => "Ψ", "Omega" => "Ω",
        "sum" => "∑", "prod" => "∏", "int" => "∫", "iint" => "∬", "oint" => "∮", "infty" | "inf" => "∞", "partial" => "∂", "nabla" => "∇",
        "pm" => "±", "mp" => "∓", "times" => "×", "div" => "÷", "cdot" => "⋅", "le" | "leq" => "≤", "ge" | "geq" => "≥", "ne" | "neq" => "≠",
        "approx" => "≈", "equiv" => "≡", "to" | "rightarrow" => "→", "leftarrow" => "←", "Rightarrow" => "⇒", "in" => "∈", "notin" => "∉",
        "subset" => "⊂", "cup" => "∪", "cap" => "∩", "forall" => "∀", "exists" => "∃", "degree" => "°", "dots" | "ldots" => "…", "cdots" => "⋯",
        "sqrt" => "√", "cbrt" => "∛",
        _ => return None,
    })
}

struct Parser {
    chars: Vec<char>,
    i: usize,
    /// Inside `■( )`, `█( )` or `√( & )`: `&` and `@` end a cell.
    cells: usize,
}

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

    /// A sequence until a closing bracket or end; builds fractions and scripts.
    fn row(&mut self, close: Option<char>) -> Node {
        let mut items: Vec<Node> = Vec::new();
        // Where the current operand began: operators and spaces end one, so
        // in `ab/c` the numerator is `ab` and in `a b/c` just `b`.
        let mut operand_start = 0;
        loop {
            let before = self.i;
            self.skip_space();
            if self.i > before {
                operand_start = items.len();
            }
            let Some(c) = self.peek() else { break };
            if Some(c) == close || ")]}⟩".contains(c) && close.is_some() || self.cells > 0 && (c == '&' || c == '@') {
                break;
            }
            // Function application (U+2061) is invisible.
            if c == '\u{2061}' {
                self.i += 1;
                continue;
            }
            if let Some(mark) = accent_mark(c) {
                self.i += 1;
                let base = items.pop().unwrap_or(Node::Row(vec![]));
                items.push(Node::Over(Box::new(base), Box::new(Node::Op(mark.into())), true));
                continue;
            }
            if c == '┬' || c == '┴' {
                self.i += 1;
                let base = items.pop().unwrap_or(Node::Row(vec![]));
                let limit = Box::new(strip_parens(self.operand()));
                items.push(if c == '┬' { Node::Under(Box::new(base), limit) } else { Node::Over(Box::new(base), limit, false) });
                continue;
            }
            if c == '¦' {
                self.i += 1;
                let mut tail = items.split_off(operand_start.min(items.len()));
                let top = if tail.len() == 1 { tail.pop().unwrap_or(Node::Row(vec![])) } else { Node::Row(tail) };
                let bottom = self.operand();
                operand_start = items.len();
                items.push(Node::Stack(Box::new(strip_parens(top)), Box::new(strip_parens(bottom))));
                continue;
            }
            if c == '/' || c == '⁄' {
                self.i += 1;
                let mut tail = items.split_off(operand_start.min(items.len()));
                let num = if tail.len() == 1 { tail.pop().unwrap_or(Node::Row(vec![])) } else { Node::Row(tail) };
                let den = self.operand();
                operand_start = items.len();
                items.push(Node::Frac(Box::new(strip_parens(num)), Box::new(strip_parens(den))));
                continue;
            }
            if c == '^' || c == '_' {
                self.i += 1;
                let base = items.pop().unwrap_or(Node::Row(vec![]));
                // A script is one atom, so x_i^2 attaches both scripts to x.
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

    /// The operand after `/` or `√`: atoms with their scripts up to the next
    /// operator, space or bracket, so `/2a` is over `2a` (as in Word and OneNote).
    fn operand(&mut self) -> Node {
        self.skip_space();
        let mut parts: Vec<Node> = Vec::new();
        while let Some(c) = self.peek() {
            if c.is_whitespace() || "/⁄¦┬┴&@".contains(c) || ")]}⟩".contains(c) || (c == '|' && !parts.is_empty()) {
                break;
            }
            if let Some(mark) = accent_mark(c) {
                self.i += 1;
                let base = parts.pop().unwrap_or(Node::Row(vec![]));
                parts.push(Node::Over(Box::new(base), Box::new(Node::Op(mark.into())), true));
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
            // An operator ends the operand, unless it leads it (a sign: 1/-2).
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
        let Some(c) = self.peek() else { return Node::Row(vec![]) };
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
                // LaTeX-style braces group without showing.
                if c == '{' {
                    return Node::Row(vec![inner]);
                }
                Node::Fenced(c.to_string(), Box::new(inner), close.to_string())
            }
            '√' if self.chars.get(self.i + 1) == Some(&'(') => {
                // √(x) or √(n&x)
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
                        Some(sym) if sym.chars().next().is_some_and(|ch| NARY.contains(&ch)) => self.nary(sym.chars().next().unwrap_or('∑')),
                        Some(sym) if sym.chars().all(char::is_alphabetic) => Node::Ident(sym.into()),
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
                // Function names stay upright words; other letters are separate variables.
                let rest: String = self.chars[self.i..].iter().take_while(|ch| ch.is_ascii_alphabetic()).collect();
                if let Some(f) = FUNCTIONS.iter().filter(|f| rest.starts_with(**f)).max_by_key(|f| f.len()) {
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
                let op = match c {
                    '*' => "×".to_string(),
                    '-' => "−".to_string(),
                    _ => c.to_string(),
                };
                Node::Op(op)
            }
        }
    }

    /// ∑_(i=1)^n a_i: limits under and over (or as scripts for integrals).
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

fn attach(base: Node, kind: char, script: Node) -> Node {
    match (kind, base) {
        ('^', Node::Sub(b, s)) => Node::SubSup(b, s, Box::new(script)),
        ('_', Node::Sup(b, s)) => Node::SubSup(b, Box::new(script), s),
        ('^', b) => Node::Sup(Box::new(b), Box::new(script)),
        (_, b) => Node::Sub(Box::new(b), Box::new(script)),
    }
}

/// UnicodeMath drops the parentheses around fraction parts and scripts: (a+b)/c.
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

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn mathml(n: &Node) -> String {
    match n {
        Node::Ident(s) if s.chars().count() > 1 => format!(r#"<mi mathvariant="normal">{}</mi>"#, esc(s)),
        Node::Ident(s) => format!("<mi>{}</mi>", esc(s)),
        Node::Num(s) => format!("<mn>{}</mn>", esc(s)),
        Node::Op(s) => format!("<mo>{}</mo>", esc(s)),
        Node::Text(s) => format!("<mtext>{}</mtext>", esc(s)),
        Node::Row(v) => format!("<mrow>{}</mrow>", v.iter().map(mathml).collect::<String>()),
        Node::Frac(a, b) => format!("<mfrac>{}{}</mfrac>", mathml(a), mathml(b)),
        Node::Sqrt(a) => format!("<msqrt>{}</msqrt>", mathml(a)),
        Node::Root(a, i) => format!("<mroot>{}{}</mroot>", mathml(a), mathml(i)),
        Node::Sub(b, s) => format!("<msub>{}{}</msub>", mathml(b), mathml(s)),
        Node::Sup(b, s) => format!("<msup>{}{}</msup>", mathml(b), mathml(s)),
        Node::SubSup(b, s, p) => format!("<msubsup>{}{}{}</msubsup>", mathml(b), mathml(s), mathml(p)),
        Node::UnderOver(op, lo, hi) => {
            let integral = matches!(&**op, Node::Op(s) if s.starts_with('∫') || s.starts_with('∬') || s.starts_with('∮'));
            let empty = || "<mrow/>".to_string();
            let tag = if integral { ("msubsup", "msub", "msup") } else { ("munderover", "munder", "mover") };
            match (lo, hi) {
                (Some(l), Some(h)) => format!("<{0}>{1}{2}{3}</{0}>", tag.0, mathml(op), mathml(l), mathml(h)),
                (Some(l), None) => format!("<{0}>{1}{2}</{0}>", tag.1, mathml(op), mathml(l)),
                (None, Some(h)) => format!("<{0}>{1}{2}</{0}>", tag.2, mathml(op), mathml(h)),
                (None, None) => {
                    let _ = empty;
                    mathml(op)
                }
            }
        }
        Node::Fenced(o, inner, c) => format!(r#"<mrow><mo fence="true">{}</mo>{}<mo fence="true">{}</mo></mrow>"#, esc(o), mathml(inner), esc(c)),
        Node::Under(b, u) => format!("<munder>{}{}</munder>", mathml(b), mathml(u)),
        Node::Over(b, o, accent) => format!("<mover{}>{}{}</mover>", if *accent { r#" accent="true""# } else { "" }, mathml(b), mathml(o)),
        Node::Table(rows) => format!(
            "<mtable>{}</mtable>",
            rows.iter().map(|r| format!("<mtr>{}</mtr>", r.iter().map(|c| format!("<mtd>{}</mtd>", mathml(c))).collect::<String>())).collect::<String>()
        ),
        Node::Stack(a, b) => format!(r#"<mfrac linethickness="0">{}{}</mfrac>"#, mathml(a), mathml(b)),
        Node::Boxed(x) => format!(r#"<menclose notation="box">{}</menclose>"#, mathml(x)),
        Node::Phantom(x) => format!("<mphantom>{}</mphantom>", mathml(x)),
    }
}

/// Office Math (OMML), as Word stores equations: the same tree as [`mathml`].
fn omml(n: &Node) -> String {
    let run = |s: &str, props: &str| format!(r#"<m:r>{props}<m:t xml:space="preserve">{}</m:t></m:r>"#, esc(s));
    let e = |n: &Node| format!("<m:e>{}</m:e>", omml(n));
    match n {
        // Function names and text stay upright.
        Node::Ident(s) if s.chars().count() > 1 => run(s, r#"<m:rPr><m:sty m:val="p"/></m:rPr>"#),
        Node::Ident(s) | Node::Num(s) | Node::Op(s) => run(s, ""),
        Node::Text(s) => run(s, "<m:rPr><m:nor/></m:rPr>"),
        Node::Row(v) => v.iter().map(omml).collect(),
        Node::Frac(a, b) => format!("<m:f><m:num>{}</m:num><m:den>{}</m:den></m:f>", omml(a), omml(b)),
        Node::Sqrt(a) => format!(r#"<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/>{}</m:rad>"#, e(a)),
        Node::Root(a, i) => format!("<m:rad><m:deg>{}</m:deg>{}</m:rad>", omml(i), e(a)),
        Node::Sub(b, s) => format!("<m:sSub>{}<m:sub>{}</m:sub></m:sSub>", e(b), omml(s)),
        Node::Sup(b, s) => format!("<m:sSup>{}<m:sup>{}</m:sup></m:sSup>", e(b), omml(s)),
        Node::SubSup(b, s, p) => format!("<m:sSubSup>{}<m:sub>{}</m:sub><m:sup>{}</m:sup></m:sSubSup>", e(b), omml(s), omml(p)),
        Node::UnderOver(op, lo, hi) => {
            let chr = match &**op {
                Node::Op(s) => s.clone(),
                _ => "∑".into(),
            };
            let integral = chr.starts_with('∫') || chr.starts_with('∬') || chr.starts_with('∮');
            let hide = |part: &Option<Box<Node>>, tag: &str| if part.is_none() { format!(r#"<m:{tag}Hide m:val="1"/>"#) } else { String::new() };
            format!(
                r#"<m:nary><m:naryPr><m:chr m:val="{}"/><m:limLoc m:val="{}"/>{}{}</m:naryPr><m:sub>{}</m:sub><m:sup>{}</m:sup><m:e/></m:nary>"#,
                esc(&chr),
                if integral { "subSup" } else { "undOvr" },
                hide(lo, "sub"),
                hide(hi, "sup"),
                lo.as_deref().map(omml).unwrap_or_default(),
                hi.as_deref().map(omml).unwrap_or_default(),
            )
        }
        Node::Fenced(o, inner, c) => format!(r#"<m:d><m:dPr><m:begChr m:val="{}"/><m:endChr m:val="{}"/></m:dPr>{}</m:d>"#, esc(o), esc(c), e(inner)),
        Node::Over(b, o, true) => {
            // An accent: Word wants the mark itself (combining form when there is one).
            let mark = match &**o {
                Node::Op(m) => m.as_str(),
                _ => "̂",
            };
            let chr = match mark {
                "^" => "\u{0302}",
                "~" => "\u{0303}",
                "¯" => "\u{0305}",
                "˙" => "\u{0307}",
                "¨" => "\u{0308}",
                "→" => "\u{20D7}",
                m => m,
            };
            if chr == "\u{0305}" {
                return format!(r#"<m:bar><m:barPr><m:pos m:val="top"/></m:barPr>{}</m:bar>"#, e(b));
            }
            format!(r#"<m:acc><m:accPr><m:chr m:val="{}"/></m:accPr>{}</m:acc>"#, esc(chr), e(b))
        }
        Node::Over(b, o, false) => match &**o {
            Node::Op(m) if OVER_MARKS.iter().any(|c| m.starts_with(*c)) => format!(r#"<m:groupChr><m:groupChrPr><m:chr m:val="{}"/><m:pos m:val="top"/></m:groupChrPr>{}</m:groupChr>"#, esc(m), e(b)),
            _ => format!("<m:limUpp>{}<m:lim>{}</m:lim></m:limUpp>", e(b), omml(o)),
        },
        Node::Under(b, u) => match &**u {
            Node::Op(m) if m == "_" => format!(r#"<m:bar><m:barPr><m:pos m:val="bot"/></m:barPr>{}</m:bar>"#, e(b)),
            Node::Op(m) if UNDER_MARKS.iter().any(|c| m.starts_with(*c)) => format!(r#"<m:groupChr><m:groupChrPr><m:chr m:val="{}"/></m:groupChrPr>{}</m:groupChr>"#, esc(m), e(b)),
            _ => format!("<m:limLow>{}<m:lim>{}</m:lim></m:limLow>", e(b), omml(u)),
        },
        Node::Table(rows) if rows.iter().all(|r| r.len() <= 1) => format!("<m:eqArr>{}</m:eqArr>", rows.iter().map(|r| r.first().map(e).unwrap_or_else(|| "<m:e/>".into())).collect::<String>()),
        Node::Table(rows) => format!("<m:m>{}</m:m>", rows.iter().map(|r| format!("<m:mr>{}</m:mr>", r.iter().map(e).collect::<String>())).collect::<String>()),
        Node::Stack(a, b) => format!(r#"<m:f><m:fPr><m:type m:val="noBar"/></m:fPr><m:num>{}</m:num><m:den>{}</m:den></m:f>"#, omml(a), omml(b)),
        Node::Boxed(x) => format!("<m:borderBox>{}</m:borderBox>", e(x)),
        Node::Phantom(x) => format!("<m:phant>{}</m:phant>", e(x)),
    }
}

fn parse(linear: &str) -> Vec<Node> {
    let mut p = Parser { chars: linear.chars().collect(), i: 0, cells: 0 };
    let mut parts = Vec::new();
    while p.i < p.chars.len() {
        parts.push(p.row(None));
        // Stray closers: show them rather than loop forever.
        if let Some(c) = p.peek() {
            p.i += 1;
            parts.push(Node::Op(c.to_string()));
        }
    }
    parts
}

/// Build up a linear-format equation into Office Math for a Word document
/// (`<m:oMath>`, needs the `m:` namespace declared by the caller).
pub fn to_omml(linear: &str) -> String {
    format!("<m:oMath>{}</m:oMath>", parse(linear).iter().map(omml).collect::<String>())
}

/// Build up a linear-format equation into MathML (`display` block or inline).
pub fn to_mathml(linear: &str, display_block: bool) -> String {
    let body: String = parse(linear).iter().map(mathml).collect();
    format!(r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="{}">{body}</math>"#, if display_block { "block" } else { "inline" })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(s: &str) -> String {
        to_mathml(s, false).replace(r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline">"#, "").replace("</math>", "")
    }

    #[test]
    fn fractions_and_scripts() {
        assert_eq!(m("a/b"), "<mfrac><mi>a</mi><mi>b</mi></mfrac>");
        assert_eq!(m("(a+b)/2"), "<mfrac><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow><mn>2</mn></mfrac>");
        assert_eq!(m("x^2"), "<msup><mi>x</mi><mn>2</mn></msup>");
        assert_eq!(m("x_i^2"), "<msubsup><mi>x</mi><mi>i</mi><mn>2</mn></msubsup>");
        assert_eq!(m("e^(i\\pi)"), "<msup><mi>e</mi><mrow><mi>i</mi><mi>π</mi></mrow></msup>");
    }

    #[test]
    fn quadratic_formula() {
        let out = m("x=(-b±√(b^2-4ac))/2a");
        assert!(out.starts_with("<mrow><mi>x</mi><mo>=</mo><mfrac>"), "{out}");
        assert!(out.contains("<msqrt><mrow><msup><mi>b</mi><mn>2</mn></msup><mo>−</mo><mn>4</mn><mi>a</mi><mi>c</mi></mrow></msqrt>"), "{out}");
        // The whole of `2a` is the denominator.
        assert!(out.ends_with("<mrow><mn>2</mn><mi>a</mi></mrow></mfrac></mrow>"), "{out}");
    }

    #[test]
    fn fraction_operands_end_at_operators_and_spaces() {
        assert_eq!(m("ab/c"), "<mfrac><mrow><mi>a</mi><mi>b</mi></mrow><mi>c</mi></mfrac>");
        assert_eq!(m("a b/c"), "<mrow><mi>a</mi><mfrac><mi>b</mi><mi>c</mi></mfrac></mrow>");
        assert_eq!(m("a/b c"), "<mrow><mfrac><mi>a</mi><mi>b</mi></mfrac><mi>c</mi></mrow>");
        assert_eq!(m("1/2+x"), "<mrow><mfrac><mn>1</mn><mn>2</mn></mfrac><mo>+</mo><mi>x</mi></mrow>");
        assert_eq!(m("y=a/x^2"), "<mrow><mi>y</mi><mo>=</mo><mfrac><mi>a</mi><msup><mi>x</mi><mn>2</mn></msup></mfrac></mrow>");
        assert_eq!(m("1/-2"), "<mfrac><mn>1</mn><mrow><mo>−</mo><mn>2</mn></mrow></mfrac>");
        assert_eq!(m("a/b/c"), "<mfrac><mfrac><mi>a</mi><mi>b</mi></mfrac><mi>c</mi></mfrac>");
    }

    #[test]
    fn nary_functions_and_latex() {
        assert_eq!(m("∑_(i=1)^n i"), "<mrow><munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></munderover><mi>i</mi></mrow>");
        assert!(m("∫_0^1 f(x)dx").starts_with("<mrow><msubsup><mo>∫</mo><mn>0</mn><mn>1</mn></msubsup>"));
        assert_eq!(m("sin x"), "<mrow><mi mathvariant=\"normal\">sin</mi><mi>x</mi></mrow>");
        assert_eq!(m("\\frac{1}{2}"), "<mfrac><mrow><mn>1</mn></mrow><mrow><mn>2</mn></mrow></mfrac>");
        assert_eq!(m("\\sqrt[3]{x}"), "<mroot><mrow><mi>x</mi></mrow><mn>3</mn></mroot>");
        assert_eq!(m("\\alpha\\le\\beta"), "<mrow><mi>α</mi><mo>≤</mo><mi>β</mi></mrow>");
    }

    #[test]
    fn constructs_from_imported_equations() {
        assert_eq!(m("■(a&b@c&d)"), "<mtable><mtr><mtd><mi>a</mi></mtd><mtd><mi>b</mi></mtd></mtr><mtr><mtd><mi>c</mi></mtd><mtd><mi>d</mi></mtd></mtr></mtable>");
        assert_eq!(m("█(x+y=1@x−y=0)").matches("<mtr>").count(), 2);
        assert_eq!(m("√(3&x)"), "<mroot><mi>x</mi><mn>3</mn></mroot>");
        assert_eq!(m("√(x+1)"), "<msqrt><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow></msqrt>");
        assert_eq!(m("lim┬(n→∞)"), "<munder><mi mathvariant=\"normal\">lim</mi><mrow><mi>n</mi><mo>→</mo><mo>∞</mo></mrow></munder>");
        assert_eq!(m("¯x"), r#"<mover accent="true"><mi>x</mi><mo>¯</mo></mover>"#);
        assert_eq!(m("x\u{0302}"), r#"<mover accent="true"><mi>x</mi><mo>^</mo></mover>"#);
        assert!(m("▭(E=mc^2)").starts_with(r#"<menclose notation="box">"#));
        assert_eq!(m("n¦k"), r#"<mfrac linethickness="0"><mi>n</mi><mi>k</mi></mfrac>"#);
        assert_eq!(m("sin\u{2061}x"), "<mrow><mi mathvariant=\"normal\">sin</mi><mi>x</mi></mrow>");
        assert!(m("⏟(a+b)").starts_with("<munder><mrow>"));
        // Word gets the matching Office Math objects.
        assert!(to_omml("■(a&b@c&d)").contains("<m:m><m:mr><m:e>"));
        assert!(to_omml("█(a@b)").contains("<m:eqArr>"));
        assert!(to_omml("√(3&x)").contains("<m:deg><m:r>"));
        assert!(to_omml("lim┬(n→∞)").contains("<m:limLow>"));
        assert!(to_omml("¯x").contains(r#"<m:pos m:val="top"/>"#));
    }

    #[test]
    fn office_math_for_word() {
        assert_eq!(to_omml("a/b"), r#"<m:oMath><m:f><m:num><m:r><m:t xml:space="preserve">a</m:t></m:r></m:num><m:den><m:r><m:t xml:space="preserve">b</m:t></m:r></m:den></m:f></m:oMath>"#);
        let q = to_omml("x=(-b±√(b^2-4ac))/2a");
        assert!(q.contains(r#"<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e><m:sSup><m:e>"#), "{q}");
        assert!(to_omml("∑_(i=1)^n i").contains(r#"<m:chr m:val="∑"/><m:limLoc m:val="undOvr"/>"#));
        assert!(to_omml("sin x").contains(r#"<m:sty m:val="p"/>"#));
    }

    #[test]
    fn never_panics_on_odd_input() {
        for s in ["", "/", "^", "))", "(((", "\\", "\\frac", "a/", "∑", "√", "\"open", "x__y^^z", "■(", "■(a&", "█(@@", "√(&", "√(3&", "┬", "a┴", "¯", "\u{0302}", "&@", "■", "⏟", "¦"] {
            let _ = to_mathml(s, true);
            let _ = to_omml(s);
        }
    }
}
