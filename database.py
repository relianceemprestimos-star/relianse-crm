import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Iterable, List, Optional, Tuple
import unicodedata

import pandas as pd


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DB_PATH = BASE_DIR / "data" / "relianse.db"


CLIENT_STATUSES = {
    "pendente",
    "enviado_hoje",
    "interessado",
    "recusado",
    "parar",
    "erro",
}


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def get_db_path() -> Path:
    configured = os.getenv("DATABASE_PATH", str(DEFAULT_DB_PATH))
    return Path(configured)


def normalize_text(value: object) -> str:
    text = "" if value is None else str(value)
    text = text.strip().lower()
    text = unicodedata.normalize("NFD", text)
    text = "".join(char for char in text if unicodedata.category(char) != "Mn")
    text = re.sub(r"\s+", " ", text)
    return text


def normalize_status(value: object) -> str:
    text = normalize_text(value)
    if not text:
        return "pendente"

    aliases = {
        "pendente": "pendente",
        "pendentes": "pendente",
        "enviado": "enviado_hoje",
        "enviados": "enviado_hoje",
        "enviado hoje": "enviado_hoje",
        "enviado_hoje": "enviado_hoje",
        "interessado": "interessado",
        "interessada": "interessado",
        "recusado": "recusado",
        "recusada": "recusado",
        "parar": "parar",
        "pediu parar": "parar",
        "pediu para parar": "parar",
        "nao enviar": "parar",
        "erro": "erro",
    }
    return aliases.get(text, text if text in CLIENT_STATUSES else "pendente")


def normalize_phone_br(value: object) -> Tuple[str, bool]:
    digits = re.sub(r"\D", "", "" if value is None else str(value))
    if not digits:
        return "", False

    if digits.startswith("00"):
        digits = digits[2:]

    if digits.startswith("55") and len(digits) in (12, 13):
        return digits, True

    if len(digits) in (10, 11):
        normalized = f"55{digits}"
        return normalized, True

    if digits.startswith("55") and len(digits) > 13:
        maybe_local = digits[2:]
        if len(maybe_local) in (10, 11):
            return f"55{maybe_local}", True

    return digits, False


def normalize_dataframe_columns(df: pd.DataFrame) -> pd.DataFrame:
    rename_map = {}
    for column in df.columns:
        key = normalize_text(column).replace(" ", "_")
        key = re.sub(r"[^a-z0-9_]", "", key)
        rename_map[column] = key
    return df.rename(columns=rename_map)


@contextmanager
def db_connection(db_path: Optional[Path] = None):
    path = db_path or get_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db(db_path: Optional[Path] = None) -> None:
    with db_connection(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS clients (
                phone_key TEXT PRIMARY KEY,
                nome TEXT,
                telefone_original TEXT,
                telefone_normalizado TEXT,
                telefone_valido INTEGER NOT NULL DEFAULT 0,
                convenio TEXT,
                oferta TEXT,
                margem TEXT,
                status TEXT NOT NULL DEFAULT 'pendente',
                observacao TEXT,
                sent_at TEXT,
                last_error TEXT,
                source_file TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS message_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phone_key TEXT,
                nome TEXT,
                direction TEXT NOT NULL,
                status_before TEXT,
                status_after TEXT,
                message_type TEXT,
                message_text TEXT,
                response_payload TEXT,
                error TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS interested_leads (
                phone_key TEXT PRIMARY KEY,
                nome TEXT,
                telefone_normalizado TEXT,
                convenio TEXT,
                oferta TEXT,
                margem TEXT,
                observacao TEXT,
                interested_at TEXT NOT NULL,
                assigned_to TEXT
            )
            """
        )


def prepare_clients_dataframe(df: pd.DataFrame, source_file: str = "") -> pd.DataFrame:
    df = normalize_dataframe_columns(df.copy())

    required = ["nome", "telefone"]
    missing = [column for column in required if column not in df.columns]
    if missing:
        raise ValueError(f"Colunas obrigatorias ausentes: {', '.join(missing)}")

    for column in ["convenio", "oferta", "margem", "status", "observacao"]:
        if column not in df.columns:
            df[column] = ""

    rows = []
    for index, row in df.iterrows():
        nome = "" if pd.isna(row.get("nome")) else str(row.get("nome")).strip()
        telefone_original = "" if pd.isna(row.get("telefone")) else str(row.get("telefone")).strip()
        telefone_normalizado, telefone_valido = normalize_phone_br(telefone_original)
        status = normalize_status(row.get("status"))
        last_error = ""

        if not telefone_valido:
            status = "erro"
            last_error = "Telefone invalido"

        if telefone_valido:
            phone_key = telefone_normalizado
        else:
            fallback = telefone_normalizado or telefone_original or nome or "sem_telefone"
            fallback = re.sub(r"[^a-zA-Z0-9]+", "_", normalize_text(fallback)).strip("_")
            phone_key = f"invalid:{fallback or index}"

        rows.append(
            {
                "phone_key": phone_key,
                "nome": nome,
                "telefone_original": telefone_original,
                "telefone_normalizado": telefone_normalizado,
                "telefone_valido": 1 if telefone_valido else 0,
                "convenio": "" if pd.isna(row.get("convenio")) else str(row.get("convenio")).strip(),
                "oferta": "" if pd.isna(row.get("oferta")) else str(row.get("oferta")).strip(),
                "margem": "" if pd.isna(row.get("margem")) else str(row.get("margem")).strip(),
                "status": status,
                "observacao": "" if pd.isna(row.get("observacao")) else str(row.get("observacao")).strip(),
                "sent_at": "",
                "last_error": last_error,
                "source_file": source_file,
            }
        )

    result = pd.DataFrame(rows)
    return result


def bulk_upsert_clients(df: pd.DataFrame, db_path: Optional[Path] = None) -> int:
    if df.empty:
        return 0

    init_db(db_path)
    timestamp = now_iso()
    records = []
    for row in df.to_dict(orient="records"):
        records.append(
            (
                row["phone_key"],
                row["nome"],
                row["telefone_original"],
                row["telefone_normalizado"],
                int(row["telefone_valido"]),
                row["convenio"],
                row["oferta"],
                row["margem"],
                row["status"],
                row["observacao"],
                row.get("sent_at", ""),
                row.get("last_error", ""),
                row.get("source_file", ""),
                timestamp,
                timestamp,
            )
        )

    with db_connection(db_path) as conn:
        conn.executemany(
            """
            INSERT INTO clients (
                phone_key, nome, telefone_original, telefone_normalizado, telefone_valido,
                convenio, oferta, margem, status, observacao, sent_at, last_error,
                source_file, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(phone_key) DO UPDATE SET
                nome=excluded.nome,
                telefone_original=excluded.telefone_original,
                telefone_normalizado=excluded.telefone_normalizado,
                telefone_valido=excluded.telefone_valido,
                convenio=excluded.convenio,
                oferta=excluded.oferta,
                margem=excluded.margem,
                status=excluded.status,
                observacao=excluded.observacao,
                sent_at=excluded.sent_at,
                last_error=excluded.last_error,
                source_file=excluded.source_file,
                updated_at=excluded.updated_at
            """,
            records,
        )
    return len(records)


def get_clients_dataframe(db_path: Optional[Path] = None) -> pd.DataFrame:
    init_db(db_path)
    with db_connection(db_path) as conn:
        return pd.read_sql_query(
            """
            SELECT
                phone_key,
                nome,
                telefone_original,
                telefone_normalizado,
                telefone_valido,
                convenio,
                oferta,
                margem,
                status,
                observacao,
                sent_at,
                last_error,
                source_file,
                created_at,
                updated_at
            FROM clients
            ORDER BY datetime(updated_at) DESC, nome COLLATE NOCASE ASC
            """,
            conn,
        )


def get_pending_clients(db_path: Optional[Path] = None) -> pd.DataFrame:
    init_db(db_path)
    with db_connection(db_path) as conn:
        return pd.read_sql_query(
            """
            SELECT *
            FROM clients
            WHERE status = 'pendente' AND telefone_valido = 1
            ORDER BY datetime(updated_at) ASC, nome COLLATE NOCASE ASC
            """,
            conn,
        )


def get_dashboard_counts(db_path: Optional[Path] = None) -> dict:
    init_db(db_path)
    with db_connection(db_path) as conn:
        row = conn.execute(
            """
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'pendente' THEN 1 ELSE 0 END) AS pendentes,
                SUM(CASE WHEN status IN ('enviado_hoje', 'enviado') THEN 1 ELSE 0 END) AS enviados,
                SUM(CASE WHEN status = 'interessado' THEN 1 ELSE 0 END) AS interessados,
                SUM(CASE WHEN status = 'recusado' THEN 1 ELSE 0 END) AS recusados,
                SUM(CASE WHEN status = 'parar' THEN 1 ELSE 0 END) AS parar,
                SUM(CASE WHEN status = 'erro' THEN 1 ELSE 0 END) AS erro
            FROM clients
            """
        ).fetchone()
    return {key: int(row[key] or 0) for key in row.keys()}


def get_interested_leads(db_path: Optional[Path] = None) -> pd.DataFrame:
    init_db(db_path)
    with db_connection(db_path) as conn:
        return pd.read_sql_query(
            """
            SELECT *
            FROM interested_leads
            ORDER BY datetime(interested_at) DESC, nome COLLATE NOCASE ASC
            """,
            conn,
        )


def get_client_by_phone(phone: str, db_path: Optional[Path] = None) -> Optional[dict]:
    init_db(db_path)
    with db_connection(db_path) as conn:
        row = conn.execute(
            """
            SELECT *
            FROM clients
            WHERE phone_key = ? OR telefone_normalizado = ? OR telefone_original = ?
            LIMIT 1
            """,
            (phone, phone, phone),
        ).fetchone()
    return dict(row) if row else None


def update_client_status(
    phone_key: str,
    status: str,
    db_path: Optional[Path] = None,
    sent_at: Optional[str] = None,
    last_error: str = "",
    observacao: Optional[str] = None,
) -> None:
    init_db(db_path)
    timestamp = now_iso()
    with db_connection(db_path) as conn:
        client = conn.execute(
            "SELECT * FROM clients WHERE phone_key = ?",
            (phone_key,),
        ).fetchone()
        if client is None:
            return

        conn.execute(
            """
            UPDATE clients
            SET status = ?, sent_at = COALESCE(?, sent_at), last_error = ?, updated_at = ?, observacao = COALESCE(?, observacao)
            WHERE phone_key = ?
            """,
            (status, sent_at, last_error, timestamp, observacao, phone_key),
        )

        if status == "interessado":
            conn.execute(
                """
                INSERT INTO interested_leads (
                    phone_key, nome, telefone_normalizado, convenio, oferta, margem, observacao, interested_at, assigned_to
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(phone_key) DO UPDATE SET
                    nome=excluded.nome,
                    telefone_normalizado=excluded.telefone_normalizado,
                    convenio=excluded.convenio,
                    oferta=excluded.oferta,
                    margem=excluded.margem,
                    observacao=excluded.observacao,
                    interested_at=excluded.interested_at
                """,
                (
                    phone_key,
                    client["nome"],
                    client["telefone_normalizado"],
                    client["convenio"],
                    client["oferta"],
                    client["margem"],
                    client["observacao"],
                    timestamp,
                    "",
                ),
            )


def record_message_log(
    phone_key: str,
    nome: str,
    direction: str,
    status_before: str = "",
    status_after: str = "",
    message_type: str = "",
    message_text: str = "",
    response_payload: str = "",
    error: str = "",
    db_path: Optional[Path] = None,
) -> None:
    init_db(db_path)
    with db_connection(db_path) as conn:
        conn.execute(
            """
            INSERT INTO message_logs (
                phone_key, nome, direction, status_before, status_after, message_type,
                message_text, response_payload, error, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                phone_key,
                nome,
                direction,
                status_before,
                status_after,
                message_type,
                message_text,
                response_payload,
                error,
                now_iso(),
            ),
        )


def export_clients_dataframe(db_path: Optional[Path] = None) -> pd.DataFrame:
    df = get_clients_dataframe(db_path)
    if df.empty:
        return df
    return df[
        [
            "nome",
            "telefone_original",
            "telefone_normalizado",
            "convenio",
            "oferta",
            "margem",
            "status",
            "observacao",
            "sent_at",
            "last_error",
            "created_at",
            "updated_at",
        ]
    ]
