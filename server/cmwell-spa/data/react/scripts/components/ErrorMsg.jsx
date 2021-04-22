let { Link } = ReactRouter

class ErrorMsg extends React.Component {
    render() {
        return <div className="error-msg-container">
            <div className="error-sign-container">
                <img id="error-sign" src="/meta/app/react/images/recoverable-error-sign.svg" />
                <div className="error-sign-text">Error occurred</div>
                <img id="cone1" src="/meta/app/react/images/cone-1.svg" />
                <img id="cone2" src="/meta/app/react/images/cone-2.svg" />
            </div>
            <div className="details">
                {this.props.children}
                <br/>
                Try again, or go back to <a href='/' onClick={()=>location.href='/'}>home page</a>.
            </div>
        </div>
    }
}

ErrorMsg.TryOrElseRenderErrMsg = block => {
    try { 
        return block()
    } catch(e) {
        return <ErrorMsg>{e.message}</ErrorMsg>
    }
}

define([], () => ErrorMsg)


