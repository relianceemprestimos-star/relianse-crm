import io
import os
from datetime import datetime
from pathlib import Path

import pandas as pd
import streamlit as st
from dotenv import load_dotenv

from database import (
    bulk_upsert_clients,
    export_clients_dataframe,
    get_dashboard_counts,
    record_message_log,
    get_interested_leads,
    get_pending_clients,
    init_db,
    prepare_clients_dataframe,
    update_client_status,
)
from whatsapp_api import WhatsAppAPIError, build_initial_message, load_whatsapp_api_from_env


load_dotenv()
init_db()


st.set_page_config(
    page_title="Relianse Agente de Vendas WhatsApp",
    page_icon="💬",
    layout="wide",
)

st.title("Relianse Agente de Vendas WhatsApp")
st.caption("Envio simples via WhatsApp Business Cloud API da Meta, com histórico local em SQLite.")

if not os.getenv("WHATSAPP_TEMPLATE_NAME", "").strip():
    st.warning(
        "Nenhum template foi configurado no .env. Para primeira abordagem em produção, a Meta normalmente exige template aprovado."
    )


def read_spreadsheet(uploaded_file) -> pd.DataFrame:
    name = uploaded_file.name.lower()
    if name.endswith(".csv"):
        try:
            return pd.read_csv(uploaded_file, dtype=str, sep=None, engine="python")
        except Exception:
            uploaded_file.seek(0)
            return pd.read_csv(uploaded_file, dtype=str, sep=";")
    return pd.read_excel(uploaded_file, dtype=str, engine="openpyxl")


def dataframe_to_excel_bytes(df: pd.DataFrame, interested_df: pd.DataFrame) -> bytes:
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="clientes")
        interested_df.to_excel(writer, index=False, sheet_name="interessados")
    return output.getvalue()


uploaded = st.file_uploader("Upload da planilha Excel ou CSV", type=["xlsx", "xls", "csv"])

if uploaded:
    raw_df = read_spreadsheet(uploaded)
    prepared_df = prepare_clients_dataframe(raw_df, source_file=uploaded.name)
    saved = bulk_upsert_clients(prepared_df)
    st.success(f"Planilha carregada com sucesso. {saved} registros foram importados/atualizados.")
    st.session_state["last_import_df"] = prepared_df

left, middle, right = st.columns(3)
counts = get_dashboard_counts()

with left:
    st.metric("Total de clientes", counts["total"])
    st.metric("Pendentes", counts["pendentes"])
    st.metric("Enviados", counts["enviados"])

with middle:
    st.metric("Interessados", counts["interessados"])
    st.metric("Recusados", counts["recusados"])
    st.metric("Pediu parar", counts["parar"])

with right:
    st.metric("Erro", counts["erro"])
    st.write("")
    st.write("")
    st.write(f"Banco local: `{Path(os.getenv('DATABASE_PATH', 'data/relianse.db'))}`")

st.divider()

col_send, col_export = st.columns([1, 1])

with col_send:
    if st.button("Enviar mensagens pendentes", type="primary"):
        pending_df = get_pending_clients()
        if pending_df.empty:
            st.info("Não há clientes pendentes para envio.")
        else:
            try:
                whatsapp = load_whatsapp_api_from_env()
            except WhatsAppAPIError as exc:
                st.error(str(exc))
            else:
                progress = st.progress(0)
                total = len(pending_df)
                results = []
                for position, (_, row) in enumerate(pending_df.iterrows(), start=1):
                    try:
                        body = build_initial_message(row["nome"])
                        response = whatsapp.send_first_approach(
                            to=row["telefone_normalizado"],
                            nome=row["nome"],
                            template_name=os.getenv("WHATSAPP_TEMPLATE_NAME", "").strip(),
                            language_code=os.getenv("WHATSAPP_TEMPLATE_LANG", "pt_BR").strip(),
                        )

                        message_id = ""
                        if isinstance(response, dict):
                            messages = response.get("messages", [])
                            if messages:
                                message_id = messages[0].get("id", "")

                        now = datetime.now().astimezone().isoformat(timespec="seconds")
                        update_client_status(
                            phone_key=row["phone_key"],
                            status="enviado_hoje",
                            sent_at=now,
                            last_error="",
                        )
                        record_message_log(
                            phone_key=row["phone_key"],
                            nome=row["nome"],
                            direction="outbound",
                            status_before=row["status"],
                            status_after="enviado_hoje",
                            message_type="template" if os.getenv("WHATSAPP_TEMPLATE_NAME", "").strip() else "text",
                            message_text=body,
                            response_payload=str(response),
                        )
                        results.append((row["nome"], "enviado", message_id))
                    except Exception as exc:
                        update_client_status(
                            phone_key=row["phone_key"],
                            status="erro",
                            last_error=str(exc),
                        )
                        record_message_log(
                            phone_key=row["phone_key"],
                            nome=row["nome"],
                            direction="outbound",
                            status_before=row["status"],
                            status_after="erro",
                            message_type="text",
                            message_text=build_initial_message(row["nome"]),
                            error=str(exc),
                        )
                        results.append((row["nome"], "erro", str(exc)))
                    progress.progress(int((position / total) * 100))

                sent_count = sum(1 for item in results if item[1] == "enviado")
                error_count = sum(1 for item in results if item[1] == "erro")
                st.success(f"Processo concluído. Enviados: {sent_count}. Erros: {error_count}.")
                st.dataframe(pd.DataFrame(results, columns=["nome", "resultado", "detalhe"]), use_container_width=True)

with col_export:
    export_df = export_clients_dataframe()
    interested_df = get_interested_leads()
    excel_bytes = dataframe_to_excel_bytes(export_df, interested_df)
    st.download_button(
        "Exportar resultado em Excel",
        data=excel_bytes,
        file_name="relianse_resultado.xlsx",
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )

st.divider()

st.subheader("Clientes cadastrados")
clients_df = export_clients_dataframe()
if clients_df.empty:
    st.info("Nenhum cliente carregado ainda.")
else:
    st.dataframe(clients_df, use_container_width=True, hide_index=True)

st.subheader("Lista de interessados para a vendedora")
interested_df = get_interested_leads()
if interested_df.empty:
    st.info("Ainda não há interessados.")
else:
    st.dataframe(interested_df, use_container_width=True, hide_index=True)
