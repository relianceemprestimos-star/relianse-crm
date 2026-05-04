import csv
import io
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.connectors import get_averbadora, list_averbadoras, normalize_averbadora_codigo
from app.core.config import get_settings
from app.core.database import get_db
from app.models.cliente import Cliente
from app.models.consulta import Consulta
from app.models.lote import Lote
from app.utils.cpf import is_valid_cpf_length, normalize_cpf
from app.utils.security import require_auth

router = APIRouter(prefix="/upload", tags=["upload"], dependencies=[Depends(require_auth)])


def _parse_records(file_name: str, raw: str) -> tuple[list[dict], list[dict]]:
    ext = file_name.lower().rsplit(".", maxsplit=1)[-1] if "." in file_name else ""
    valid_rows: list[dict] = []
    invalid_rows: list[dict] = []

    if ext in {"txt"}:
        for idx, line in enumerate(raw.splitlines(), start=1):
            value = line.strip()
            if not value:
                continue
            cpf = normalize_cpf(value)
            if not is_valid_cpf_length(cpf):
                invalid_rows.append({"linha": idx, "cpf_original": value, "motivo": "CPF invalido"})
                continue
            valid_rows.append({"cpf": cpf, "nome": "", "matricula": "", "orgao": ""})
        return valid_rows, invalid_rows

    content = io.StringIO(raw)
    sample = raw.splitlines()[0] if raw.splitlines() else ""
    delimiter = ";" if sample.count(";") >= sample.count(",") else ","
    reader = csv.DictReader(content, delimiter=delimiter)

    for idx, row in enumerate(reader, start=2):
        cpf_raw = row.get("CPF") or row.get("cpf") or row.get("Cpf") or ""
        cpf = normalize_cpf(cpf_raw)
        if not is_valid_cpf_length(cpf):
            invalid_rows.append({"linha": idx, "cpf_original": cpf_raw, "motivo": "CPF invalido"})
            continue
        valid_rows.append(
            {
                "cpf": cpf,
                "nome": (row.get("NOME") or row.get("nome") or "").strip(),
                "matricula": (row.get("MATRICULA") or row.get("matricula") or "").strip(),
                "orgao": (row.get("ORGAO") or row.get("orgao") or row.get("Ã“RGÃƒO") or "").strip(),
            }
        )
    return valid_rows, invalid_rows


@router.get("/averbadoras")
def listar_averbadoras():
    return {"itens": list_averbadoras()}


@router.post("/lotes")
async def criar_lote(
    file: UploadFile = File(...),
    averbadora_codigo: str = Form(default="portal_padrao"),
    db: Session = Depends(get_db),
):
    settings = get_settings()
    raw_bytes = await file.read()
    raw_text = raw_bytes.decode("utf-8-sig", errors="ignore")
    if not raw_text.strip():
        raise HTTPException(status_code=400, detail="Arquivo vazio")

    valid_rows, invalid_rows = _parse_records(file.filename or "lote.csv", raw_text)
    if not valid_rows:
        raise HTTPException(status_code=400, detail="Nenhum CPF valido encontrado")

    unique = {}
    for row in valid_rows:
        key = f"{row['cpf']}|{row.get('matricula','')}"
        unique[key] = row
    deduped_rows = list(unique.values())
    averbadora_codigo = normalize_averbadora_codigo(averbadora_codigo)
    try:
        averbadora = get_averbadora(averbadora_codigo)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    lote = Lote(
        nome_arquivo=file.filename or f"lote_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
        averbadora_codigo=averbadora_codigo,
        status="pendente",
        total_registros=len(deduped_rows),
        pendentes=len(deduped_rows),
    )
    db.add(lote)
    db.flush()

    for row in deduped_rows:
        cliente = Cliente(
            lote_id=lote.id,
            cpf=row["cpf"],
            nome=row.get("nome") or None,
            matricula=row.get("matricula") or None,
            orgao=row.get("orgao") or None,
        )
        db.add(cliente)
        db.flush()
        db.add(Consulta(lote_id=lote.id, cliente_id=cliente.id, status="pendente"))

    db.commit()

    file_path = settings.uploads_dir / f"lote_{lote.id}_{lote.nome_arquivo}"
    file_path.write_bytes(raw_bytes)

    return {
        "lote_id": lote.id,
        "arquivo": lote.nome_arquivo,
        "averbadora": {"codigo": averbadora.codigo, "nome": averbadora.nome},
        "total_validos": len(deduped_rows),
        "total_invalidos": len(invalid_rows),
        "duplicados_removidos": len(valid_rows) - len(deduped_rows),
        "invalidos": invalid_rows[:50],
    }

