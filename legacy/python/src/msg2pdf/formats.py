"""File formats supported by the optional mixed-folder workflow."""

WORD_EXTENSIONS = {".doc", ".docx", ".docm", ".dot", ".dotx", ".dotm", ".rtf"}
EXCEL_EXTENSIONS = {".xls", ".xlsx", ".xlsm", ".xlsb", ".xlt", ".xltx", ".xltm"}
POWERPOINT_EXTENSIONS = {
    ".ppt",
    ".pptx",
    ".pptm",
    ".pps",
    ".ppsx",
    ".ppsm",
    ".pot",
    ".potx",
    ".potm",
}
EMAIL_EXTENSIONS = {".msg", ".eml"}
OFFICE_EXTENSIONS = WORD_EXTENSIONS | EXCEL_EXTENSIONS | POWERPOINT_EXTENSIONS
PDF_SOURCE_EXTENSIONS = OFFICE_EXTENSIONS | EMAIL_EXTENSIONS | {".pdf"}
