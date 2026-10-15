//! `notecraft`: read and edit a Notecraft library from the command line, or
//! run as an MCP server so AI agents can use it (`notecraft mcp`).
//!
//! Changes go straight to the library folder; a running Notecraft app shows
//! them within a second.

mod mcp;

use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use notecraft_core::{ops, LibraryStore};
use serde_json::{json, Value};

#[derive(Parser)]
#[command(name = "notecraft", version, about = "Read and edit your Notecraft notes from the command line or an AI agent")]
struct Cli {
    /// Library folder (default: $NOTECRAFT_LIBRARY or ~/Documents/Notecraft)
    #[arg(long, global = true, value_name = "DIR")]
    library: Option<PathBuf>,
    /// Print JSON instead of text
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Where the library is and what it holds
    Info,
    /// Notebooks, sections and pages
    List,
    /// A page as Markdown (or JSON with --json)
    Show { page: String },
    /// Search titles, notes, table cells and text in pictures
    Search {
        query: String,
        #[arg(long)]
        notebook: Option<String>,
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Open to-dos across the library
    Todos {
        /// Include checked items
        #[arg(long)]
        all: bool,
    },
    /// Add a page to a section (id, "Section" or "Notebook/Section"); notes are Markdown
    NewPage {
        section: String,
        title: String,
        /// Markdown text, or "-" to read standard input
        #[arg(allow_hyphen_values = true)]
        markdown: Option<String>,
    },
    /// Add Markdown notes to the end of a page ("-" reads standard input)
    Append {
        page: String,
        #[arg(allow_hyphen_values = true)]
        markdown: String,
    },
    /// Check (or with --undo, uncheck) a to-do
    Check {
        page: String,
        element: String,
        #[arg(long)]
        undo: bool,
    },
    /// Rename a page
    Rename { page: String, title: String },
    /// Move a page to Deleted Notes
    Delete { page: String },
    /// Create a notebook
    NewNotebook { name: String },
    /// Create a section in a notebook
    NewSection { notebook: String, name: String },
    /// Export a notebook as .notecraft.json
    Export {
        notebook: String,
        #[arg(long, value_name = "FILE")]
        out: Option<PathBuf>,
    },
    /// Show a page in the running Notecraft app
    Open { page: String },
    /// Run as a Model Context Protocol server on stdin/stdout
    Mcp,
}

fn text_arg(s: Option<String>) -> std::io::Result<String> {
    match s.as_deref() {
        Some("-") => {
            let mut buf = String::new();
            std::io::stdin().read_to_string(&mut buf)?;
            Ok(buf)
        }
        Some(t) => Ok(t.replace("\\n", "\n")),
        None => Ok(String::new()),
    }
}

fn print_outline(v: &Value) {
    println!("Library: {}", v["library"].as_str().unwrap_or(""));
    for nb in v["notebooks"].as_array().into_iter().flatten() {
        println!("\n{}  [{}]", nb["name"].as_str().unwrap_or(""), nb["id"].as_str().unwrap_or(""));
        for s in nb["sections"].as_array().into_iter().flatten() {
            let group = s["group"].as_str().map(|g| format!("{g} › ")).unwrap_or_default();
            println!("  {group}{}  [{}]", s["name"].as_str().unwrap_or(""), s["id"].as_str().unwrap_or(""));
            for p in s["pages"].as_array().into_iter().flatten() {
                let indent = "  ".repeat(p["level"].as_u64().unwrap_or(1) as usize);
                let title = p["title"].as_str().filter(|t| !t.is_empty()).unwrap_or("Untitled page");
                println!("  {indent}{title}  [{}]", p["id"].as_str().unwrap_or(""));
            }
        }
    }
}

fn run(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    let root = cli.library.unwrap_or_else(LibraryStore::default_root);
    if let Command::Mcp = cli.command {
        return mcp::serve(LibraryStore::open(root)?);
    }
    let store = LibraryStore::open(&root)?;
    let out: Value = match cli.command {
        Command::Info => {
            let o = ops::outline(&store)?;
            let nbs = o["notebooks"].as_array().cloned().unwrap_or_default();
            let sections: usize = nbs.iter().map(|n| n["sections"].as_array().map(Vec::len).unwrap_or(0)).sum();
            let pages: usize = nbs.iter().flat_map(|n| n["sections"].as_array().cloned().unwrap_or_default()).map(|s| s["pages"].as_array().map(Vec::len).unwrap_or(0)).sum();
            json!({ "library": root.display().to_string(), "exists": store.exists(), "notebooks": nbs.len(), "sections": sections, "pages": pages })
        }
        Command::List => {
            let o = ops::outline(&store)?;
            if !cli.json {
                print_outline(&o);
                return Ok(());
            }
            o
        }
        Command::Show { page } => {
            if cli.json {
                ops::read_page(&store, &page)?
            } else {
                print!("{}", ops::read_page_markdown(&store, &page)?["markdown"].as_str().unwrap_or(""));
                return Ok(());
            }
        }
        Command::Search { query, notebook, limit } => {
            let hits = ops::search(&store, &query, notebook.as_deref(), limit)?;
            if !cli.json {
                for h in &hits {
                    println!("{}  ({} › {})  [{}]\n    {}", h["title"].as_str().unwrap_or(""), h["notebook"].as_str().unwrap_or(""), h["section"].as_str().unwrap_or(""), h["pageId"].as_str().unwrap_or(""), h["snippet"].as_str().unwrap_or(""));
                }
                if hits.is_empty() {
                    println!("No pages match “{query}”.");
                }
                return Ok(());
            }
            json!(hits)
        }
        Command::Todos { all } => {
            let items = ops::todos(&store, all)?;
            if !cli.json {
                for t in &items {
                    println!("{} {}  — {}  [{} {}]", if t["done"] == true { "[x]" } else { "[ ]" }, t["text"].as_str().unwrap_or(""), t["page"].as_str().unwrap_or(""), t["pageId"].as_str().unwrap_or(""), t["elementId"].as_str().unwrap_or(""));
                }
                return Ok(());
            }
            json!(items)
        }
        Command::NewPage { section, title, markdown } => json!({ "pageId": ops::create_page(&store, &section, &title, &text_arg(markdown)?)? }),
        Command::Append { page, markdown } => json!({ "added": ops::append_markdown(&store, &page, &text_arg(Some(markdown))?)? }),
        Command::Check { page, element, undo } => {
            ops::set_todo(&store, &page, &element, !undo)?;
            json!({ "ok": true })
        }
        Command::Rename { page, title } => {
            ops::rename_page(&store, &page, &title)?;
            json!({ "ok": true })
        }
        Command::Delete { page } => {
            ops::delete_page(&store, &page)?;
            json!({ "ok": true })
        }
        Command::NewNotebook { name } => json!({ "notebookId": ops::create_notebook(&store, &name)? }),
        Command::NewSection { notebook, name } => json!({ "sectionId": ops::create_section(&store, &notebook, &name)? }),
        Command::Export { notebook, out } => {
            let data = ops::export_notebook(&store, &notebook)?;
            match out {
                Some(path) => {
                    std::fs::write(&path, serde_json::to_vec(&data)?)?;
                    json!({ "path": path.display().to_string() })
                }
                None => data,
            }
        }
        Command::Open { page } => {
            ops::request_ui(&store, json!({ "action": "openPage", "pageId": page }))?;
            json!({ "ok": true })
        }
        Command::Mcp => unreachable!(),
    };
    if cli.json {
        println!("{}", serde_json::to_string_pretty(&out)?);
    } else {
        match &out {
            Value::Object(o) if o.len() == 1 => println!("{}", o.values().next().map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())).unwrap_or_default()),
            _ => println!("{}", serde_json::to_string_pretty(&out)?),
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("notecraft: {e}");
            ExitCode::FAILURE
        }
    }
}
