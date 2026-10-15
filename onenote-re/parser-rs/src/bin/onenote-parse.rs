//! The `onenote-parse` CLI: the Rust counterpart of parser/src/cli.ts, printing
//! the same JSON.
//!
//! ```text
//! Usage: onenote-parse <file.one|file.onetoc2|-> [--raw] [--assets <dir>] [--cache <dir> | --no-cache] [--out <file.json>]
//!                      [--versions] [--toc] [--asset-ids] [--timing]
//!   --raw        dump the full revision-store object graph instead of blocks
//!   --assets     write embedded images/attachments to <dir> and reference them
//!   --cache      OneNote cache folder to take missing (<invfdo>) file data from;
//!                by default the `cache` sibling of a .../15.0/Backup tree is used
//!   --no-cache   never read a cache folder
//!   --out        write the JSON to a file instead of stdout
//! Beyond the TypeScript CLI (parser/src/cli.ts):
//!   -            read the file from stdin (no section name)
//!   --versions   include each page's version history (ConvertOptions.includeVersions)
//!   --toc        convert as a .onetoc2 whatever the header says
//!   --asset-ids  set asset.ref to "<asset id> sha256:<first 16 hex digits>" (for differential tests)
//!   --timing     print the cache index + parse + convert + serialize time to stderr
//! ```

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    if let Err(e) = cli::run() {
        eprintln!("Error: {e}");
        std::process::exit(1);
    }
}

#[cfg(target_arch = "wasm32")]
fn main() {}

#[cfg(not(target_arch = "wasm32"))]
mod cli {
    use std::fs;
    use std::io::{Read, Write};
    use std::path::Path;
    use std::time::Instant;

    use onenote_re::cache::OneNoteCache;
    use onenote_re::onestore::FileKind;
    use onenote_re::reader::hex;
    use onenote_re::{
        dump_object_graph, json, notebook_toc, Asset, ConvertOptions, NotebookConverter, OneStore,
    };
    use sha2::{Digest, Sha256};

    const USAGE: &str = "usage: onenote-parse <file.one|file.onetoc2> [--raw] [--assets <dir>] [--cache <dir> | --no-cache] [--out <file.json>] [--versions] [--toc] [--asset-ids] [--timing]";

    /// Removes the first `name` and the value after it, like cli.ts's `flag`.
    fn flag(args: &mut Vec<String>, name: &str) -> Option<String> {
        let i = args.iter().position(|a| a == name)?;
        let v = args.get(i + 1).cloned();
        args.drain(i..(i + 2).min(args.len()));
        v
    }

    fn bool_flag(args: &mut Vec<String>, name: &str) -> bool {
        match args.iter().position(|a| a == name) {
            Some(i) => {
                args.remove(i);
                true
            }
            None => false,
        }
    }

    /// Node's `path.basename(p, path.extname(p))`.
    fn section_name(input: &str) -> String {
        let base = input.trim_end_matches('/').rsplit('/').next().unwrap_or("");
        let ext = match base.rfind('.') {
            Some(i) if i > 0 && base != ".." => &base[i..],
            _ => "",
        };
        if !ext.is_empty() && base != ext {
            base[..base.len() - ext.len()].to_string()
        } else {
            base.to_string()
        }
    }

    pub fn run() -> Result<(), Box<dyn std::error::Error>> {
        let mut args: Vec<String> = std::env::args().skip(1).collect();
        let raw = bool_flag(&mut args, "--raw");
        let no_cache = bool_flag(&mut args, "--no-cache");
        let asset_dir = flag(&mut args, "--assets");
        let out_file = flag(&mut args, "--out");
        let cache_arg = flag(&mut args, "--cache");
        let include_versions = bool_flag(&mut args, "--versions");
        let force_toc = bool_flag(&mut args, "--toc");
        let asset_ids = bool_flag(&mut args, "--asset-ids");
        let timing = bool_flag(&mut args, "--timing");
        let Some(input) = args.first().cloned() else {
            eprintln!("{USAGE}");
            std::process::exit(2);
        };

        // --timing covers cache indexing, parse, convert and serialize (not
        // reading the input), like the differential test's TypeScript timing.
        let started = Instant::now();
        let cache_dir = if no_cache {
            None
        } else {
            cache_arg
                .map(Into::into)
                .or_else(|| OneNoteCache::find_for(&input))
        };
        let cache = match cache_dir {
            Some(dir) if !raw => Some(OneNoteCache::new(dir)?),
            _ => None,
        };

        let read_started = Instant::now();
        let bytes = if input == "-" {
            let mut b = Vec::new();
            std::io::stdin().read_to_end(&mut b)?;
            b
        } else {
            fs::read(&input)?
        };
        let read_time = read_started.elapsed();
        let store = OneStore::new(&bytes)?;
        let mut lookups = None;
        let text = if raw {
            json::to_string_pretty(&dump_object_graph(&store))?
        } else if store.header.file_kind == FileKind::Toc || force_toc {
            json::to_string_pretty(&notebook_toc(&store))?
        } else {
            let resolver = cache.as_ref().map(|c| c.resolver());
            let on_asset = |a: Asset<'_>| -> Option<String> {
                if asset_ids {
                    let digest = hex(&Sha256::digest(a.bytes));
                    return Some(format!("{} sha256:{}", a.id, &digest[..16]));
                }
                let dir = asset_dir.as_deref()?;
                let ext = match a.extension {
                    Some(e) => e.to_string(),
                    None => format!(".{}", a.media_type.split('/').nth(1).unwrap_or("bin")),
                };
                let name = format!("{}{ext}", &hex(&Sha256::digest(a.bytes))[..16]);
                if let Err(e) = fs::create_dir_all(dir)
                    .and_then(|_| fs::write(Path::new(dir).join(&name), a.bytes))
                {
                    eprintln!("Error: {e}");
                    std::process::exit(1);
                }
                Some(name)
            };
            let opts = ConvertOptions {
                section_name: (input != "-").then(|| section_name(&input)),
                include_versions,
                on_asset: (asset_ids || asset_dir.is_some())
                    .then(|| Box::new(on_asset) as onenote_re::AssetHook),
                resolve_file_data: resolver.map(|r| Box::new(r) as onenote_re::FileDataResolver),
            };
            let out = NotebookConverter::new(&store, opts).convert();
            lookups = Some(out.diagnostics.file_data_lookups);
            json::to_string_pretty(&out)?
        };
        if timing {
            eprintln!(
                "onenote-parse: {:.3} ms",
                (started.elapsed() - read_time).as_secs_f64() * 1000.0
            );
        }
        if let (Some(cache), Some(l)) = (&cache, lookups) {
            let s = cache.stats();
            let (resolved, requested) = l.map_or((0, 0), |l| (l.resolved, l.requested));
            eprintln!(
                "cache {}: {} files ({} file data, {} encrypted); resolved {resolved}/{requested} missing file data objects",
                s.dir, s.files, s.file_data, s.encrypted
            );
        }
        match out_file {
            Some(path) => fs::write(path, text)?,
            None => {
                let mut stdout = std::io::stdout().lock();
                stdout.write_all(text.as_bytes())?;
                stdout.write_all(b"\n")?;
            }
        }
        Ok(())
    }
}
