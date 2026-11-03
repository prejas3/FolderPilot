//! CCS/1 Rust-side UI language: tray menu, window titles, errors shown to the user.
//! STATE:one process-wide flag; "pl"|"en"; start=settings.lang ?? Windows UI language (non-Polish->en)
//! USE:tr("en","pl") for fixed text, tr!("en {x}","pl {x}") for formatted text
use std::sync::atomic::{AtomicBool, Ordering};

static POLISH: AtomicBool = AtomicBool::new(false);

pub fn set(lang: &str) {
    POLISH.store(lang == "pl", Ordering::Release);
}

pub fn lang() -> &'static str {
    if is_pl() {
        "pl"
    } else {
        "en"
    }
}

pub fn is_pl() -> bool {
    POLISH.load(Ordering::Acquire)
}

/// The text in the current language.
pub fn tr(en: &'static str, pl: &'static str) -> &'static str {
    if is_pl() {
        pl
    } else {
        en
    }
}

/// `tr!("en {x}", "pl {x}")`: format! in the current language.
#[macro_export]
macro_rules! tr {
    ($en:literal, $pl:literal $(, $arg:expr)* $(,)?) => {
        if $crate::i18n::is_pl() { format!($pl $(, $arg)*) } else { format!($en $(, $arg)*) }
    };
}

/// Polish when the Windows display language is Polish, else English.
pub fn system_lang() -> &'static str {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetUserDefaultUILanguage() -> u16;
        }
        const LANG_POLISH: u16 = 0x15;
        // SAFETY: no arguments, returns a LANGID.
        if unsafe { GetUserDefaultUILanguage() } & 0x3ff == LANG_POLISH {
            return "pl";
        }
    }
    "en"
}
